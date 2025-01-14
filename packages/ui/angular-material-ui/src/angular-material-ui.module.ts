import { ClipboardModule } from '@angular/cdk/clipboard';
import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatToolbarModule } from '@angular/material/toolbar';
import { ReactiveComponentModule } from '@ngrx/component';

import { WalletConnectButtonComponent, WalletConnectButtonDirective } from './connect-button';
import {
    WalletModalButtonComponent,
    WalletModalButtonDirective,
    WalletModalComponent,
    WalletExpandComponent,
    WalletListItemComponent,
} from './modal';
import { WalletDisconnectButtonComponent, WalletDisconnectButtonDirective } from './disconnect-button';
import { WalletMultiButtonComponent } from './multi-button';
import { ObscureAddressPipe, SanitizeUrlPipe, WalletIconComponent } from './shared';

@NgModule({
    imports: [
        CommonModule,
        ClipboardModule,
        MatButtonModule,
        MatDialogModule,
        MatIconModule,
        MatListModule,
        MatMenuModule,
        MatToolbarModule,
        ReactiveComponentModule,
    ],
    exports: [
        WalletConnectButtonComponent,
        WalletConnectButtonDirective,
        WalletDisconnectButtonComponent,
        WalletDisconnectButtonDirective,
        WalletMultiButtonComponent,
        WalletModalButtonComponent,
        WalletModalButtonDirective,
        WalletModalComponent,
        WalletIconComponent,
    ],
    declarations: [
        WalletConnectButtonComponent,
        WalletConnectButtonDirective,
        WalletDisconnectButtonComponent,
        WalletDisconnectButtonDirective,
        WalletMultiButtonComponent,
        WalletModalButtonComponent,
        WalletModalButtonDirective,
        WalletModalComponent,
        WalletListItemComponent,
        WalletExpandComponent,
        WalletIconComponent,
        SanitizeUrlPipe,
        ObscureAddressPipe,
    ],
})
export class WalletUiModule {}
