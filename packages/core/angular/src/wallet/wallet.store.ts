import { Inject, Injectable, Optional } from '@angular/core';
import { ComponentStore } from '@ngrx/component-store';
import {
    Adapter,
    SendTransactionOptions,
    Wallet,
    WalletName,
    WalletNotConnectedError,
    WalletNotReadyError,
} from '@solana/wallet-adapter-base';
import { Connection, PublicKey, Transaction, TransactionSignature } from '@solana/web3.js';
import {
    BehaviorSubject,
    combineLatest,
    defer,
    EMPTY,
    from,
    fromEvent,
    Observable,
    of,
    Subject,
    throwError,
} from 'rxjs';
import { catchError, concatMap, filter, finalize, first, map, switchMap, tap, withLatestFrom } from 'rxjs/operators';

import { fromAdapterEvent, isNotNull } from '../operators';
import { LocalStorageService } from './local-storage';
import { WalletNotSelectedError } from './wallet.errors';
import { signAllTransactions, signMessage, signTransaction } from './wallet.signer';
import { WALLET_CONFIG } from './wallet.tokens';
import { WalletConfig } from './wallet.types';

const WALLET_DEFAULT_CONFIG: WalletConfig = {
    autoConnect: false,
    localStorageKey: 'walletName',
};

interface WalletState {
    wallets: Wallet[];
    wallet: Wallet | null;
    adapter: Adapter | null;
    connecting: boolean;
    disconnecting: boolean;
    connected: boolean;
    ready: boolean;
    publicKey: PublicKey | null;
    autoConnect: boolean;
}

const initialState: {
    wallet: Wallet | null;
    adapter: Adapter | null;
    ready: boolean;
    connected: boolean;
    publicKey: PublicKey | null;
} = {
    wallet: null,
    adapter: null,
    ready: false,
    connected: false,
    publicKey: null,
};

@Injectable()
export class WalletStore extends ComponentStore<WalletState> {
    private readonly _error = new Subject();
    private readonly _name = new LocalStorageService<WalletName | null>(
        this._config?.localStorageKey || 'walletName',
        null
    );
    private readonly _unloading = new BehaviorSubject(false);
    private readonly unloading$ = this._unloading.asObservable();
    readonly wallets$ = this.select(({ wallets }) => wallets);
    readonly autoConnect$ = this.select(({ autoConnect }) => autoConnect);
    readonly wallet$ = this.select(({ wallet }) => wallet);
    readonly adapter$ = this.select(({ adapter }) => adapter);
    readonly publicKey$ = this.select(({ publicKey }) => publicKey);
    readonly ready$ = this.select(({ ready }) => ready);
    readonly connecting$ = this.select(({ connecting }) => connecting);
    readonly disconnecting$ = this.select(({ disconnecting }) => disconnecting);
    readonly connected$ = this.select(({ connected }) => connected);
    readonly name$ = this._name.value$;
    readonly error$ = this._error.asObservable();
    readonly anchorWallet$ = this.select(
        this.publicKey$,
        this.adapter$,
        this.connected$,
        (publicKey, adapter, connected) => {
            const adapterSignTransaction =
                adapter && 'signTransaction' in adapter ? signTransaction(adapter, connected, this._error) : undefined;
            const adapterSignAllTransactions =
                adapter && 'signAllTransactions' in adapter
                    ? signAllTransactions(adapter, connected, this._error)
                    : undefined;

            return publicKey && adapterSignTransaction && adapterSignAllTransactions
                ? {
                      publicKey,
                      signTransaction: (transaction: Transaction) => adapterSignTransaction(transaction).toPromise(),
                      signAllTransactions: (transactions: Transaction[]) =>
                          adapterSignAllTransactions(transactions).toPromise(),
                  }
                : undefined;
        },
        { debounce: true }
    );

    // Map of wallet names to wallets
    private readonly _walletsByName$ = this.select(this.wallets$, (wallets) =>
        wallets.reduce<Record<WalletName, Wallet>>((walletsByName, wallet) => {
            walletsByName[wallet.name] = wallet;
            return walletsByName;
        }, {})
    );

    constructor(
        @Optional()
        @Inject(WALLET_CONFIG)
        private _config: WalletConfig
    ) {
        super();

        this._config = {
            ...WALLET_DEFAULT_CONFIG,
            ...this._config,
        };

        this.setState({
            ...initialState,
            wallets: [],
            connecting: false,
            disconnecting: false,
            autoConnect: this._config?.autoConnect || false,
        });
    }

    // Set wallets
    readonly setWallets = this.effect((wallets$: Observable<Wallet[]>) =>
        wallets$.pipe(tap((wallets) => this.patchState({ wallets })))
    );

    // When the selected wallet changes, initialize the state
    readonly onWalletChanged = this.effect(() =>
        combineLatest([this.name$, this._walletsByName$]).pipe(
            tap(([name, walletsByName]) => {
                const wallet = (name && walletsByName[name]) || null;
                const adapter = wallet && wallet.adapter;

                if (adapter) {
                    const { publicKey, connected } = adapter;
                    this._name.setItem(name);
                    this.patchState({
                        adapter,
                        wallet,
                        publicKey,
                        connected,
                        ready: false,
                    });
                } else {
                    this.patchState(initialState);
                }
            })
        )
    );

    // Update ready state for newly selected adapter
    readonly onAdapterChanged = this.effect(() =>
        this.adapter$.pipe(
            isNotNull,

            concatMap((adapter) =>
                from(defer(() => adapter.ready())).pipe(tap((ready) => this.patchState({ ready: !!ready })))
            )
        )
    );

    // If the window is closing or reloading, ignore disconnect and error events from the adapter
    readonly handleUnload = this.effect(() => {
        if (typeof window === 'undefined') {
            return of(null);
        }

        return fromEvent(window, 'beforeunload').pipe(tap(() => this._unloading.next(true)));
    });

    // If autoConnect is enabled, try to connect when the adapter changes and is ready
    readonly autoConnect = this.effect(() => {
        return combineLatest([
            this.autoConnect$,
            this.adapter$.pipe(isNotNull),
            this.ready$,
            this.connecting$,
            this.connected$,
        ]).pipe(
            filter(
                ([autoConnect, , ready, connecting, connected]) => autoConnect && ready && !connecting && !connected
            ),
            concatMap(([, adapter]) => {
                this.patchState({ connecting: true });
                return from(defer(() => adapter.connect())).pipe(
                    catchError(() => {
                        // Clear the selected wallet
                        this._name.setItem(null);
                        // Don't throw error, but onError will still be called
                        return of(null);
                    }),
                    finalize(() => this.patchState({ connecting: false }))
                );
            })
        );
    });

    // Select a wallet by name
    readonly selectWallet = this.effect((newName$: Observable<WalletName | null>) => {
        return newName$.pipe(
            concatMap((action) => of(action).pipe(withLatestFrom(this.name$, this.adapter$))),
            filter(([newName, name]) => newName !== name),
            concatMap(([newName, , adapter]) => {
                if (!adapter) {
                    return of(newName);
                } else {
                    return from(defer(() => adapter.disconnect())).pipe(
                        map(() => newName),
                        catchError(() => EMPTY)
                    );
                }
            }),
            tap((newName) => this._name.setItem(newName))
        );
    });

    // Handle the adapter's connect event
    readonly onConnect = this.effect(() => {
        return this.adapter$.pipe(
            isNotNull,
            switchMap((adapter) =>
                fromAdapterEvent(adapter, 'connect').pipe(
                    tap(() => {
                        const { connected, publicKey } = adapter;

                        this.patchState({
                            connected,
                            publicKey,
                        });
                    })
                )
            )
        );
    });

    // Handle the adapter's disconnect event
    readonly onDisconnect = this.effect(() => {
        return combineLatest([this.adapter$.pipe(isNotNull), this.unloading$]).pipe(
            switchMap(([adapter, unloading]) =>
                fromAdapterEvent(adapter, 'disconnect').pipe(tap(() => !unloading && this._name.setItem(null)))
            )
        );
    });

    // Handle the adapter's error event
    readonly onError = this.effect(() => {
        return combineLatest([this.adapter$.pipe(isNotNull), this.unloading$]).pipe(
            switchMap(([adapter, unloading]) =>
                fromAdapterEvent(adapter, 'error').pipe(tap((error) => !unloading && this._error.next(error)))
            )
        );
    });

    // Connect the adapter to the wallet
    connect(): Observable<unknown> {
        return combineLatest([
            this.connecting$,
            this.disconnecting$,
            this.connected$,
            this.wallet$,
            this.adapter$,
            this.ready$,
        ]).pipe(
            first(),
            filter(([connecting, disconnecting, connected]) => !connected && !connecting && !disconnecting),
            concatMap(([, , , wallet, adapter, ready]) => {
                if (!wallet || !adapter) {
                    const error = new WalletNotSelectedError();
                    this._error.next(error);
                    return throwError(error);
                }

                if (!ready) {
                    this._name.setItem(null);

                    if (typeof window !== 'undefined') {
                        window.open(wallet.url, '_blank');
                    }

                    const error = new WalletNotReadyError();
                    this._error.next(error);
                    return throwError(error);
                }

                this.patchState({ connecting: true });

                return from(defer(() => adapter.connect())).pipe(
                    catchError((error) => {
                        this._name.setItem(null);
                        return throwError(error);
                    }),
                    finalize(() => this.patchState({ connecting: false }))
                );
            })
        );
    }

    // Disconnect the adapter from the wallet
    disconnect(): Observable<unknown> {
        return combineLatest([this.disconnecting$, this.adapter$]).pipe(
            first(),
            filter(([disconnecting]) => !disconnecting),
            concatMap(([, adapter]) => {
                if (!adapter) {
                    this._name.setItem(null);
                    return EMPTY;
                } else {
                    this.patchState({ disconnecting: true });
                    return from(defer(() => adapter.disconnect())).pipe(
                        finalize(() => {
                            this._name.setItem(null);
                            this.patchState({ disconnecting: false });
                        })
                    );
                }
            })
        );
    }

    // Send a transaction using the provided connection
    sendTransaction(
        transaction: Transaction,
        connection: Connection,
        options?: SendTransactionOptions
    ): Observable<TransactionSignature> {
        return combineLatest([this.adapter$, this.connected$]).pipe(
            first(),
            concatMap(([adapter, connected]) => {
                if (!adapter) {
                    const error = new WalletNotSelectedError();
                    this._error.next(error);
                    return throwError(error);
                }

                if (!connected) {
                    const error = new WalletNotConnectedError();
                    this._error.next(error);
                    return throwError(error);
                }

                return from(defer(() => adapter.sendTransaction(transaction, connection, options)));
            })
        );
    }

    // Sign a transaction if the wallet supports it
    signTransaction(transaction: Transaction): Observable<Transaction> | undefined {
        const { adapter, connected } = this.get();

        return adapter && 'signTransaction' in adapter
            ? signTransaction(adapter, connected, this._error)(transaction)
            : undefined;
    }

    // Sign multiple transactions if the wallet supports it
    signAllTransactions(transactions: Transaction[]): Observable<Transaction[]> | undefined {
        const { adapter, connected } = this.get();

        return adapter && 'signAllTransactions' in adapter
            ? signAllTransactions(adapter, connected, this._error)(transactions)
            : undefined;
    }

    // Sign an arbitrary message if the wallet supports it
    signMessage(message: Uint8Array): Observable<Uint8Array> | undefined {
        const { adapter, connected } = this.get();

        return adapter && 'signMessage' in adapter ? signMessage(adapter, connected, this._error)(message) : undefined;
    }
}
