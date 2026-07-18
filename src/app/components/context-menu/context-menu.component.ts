import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ContextMenuService } from '../../services/context-menu.service';

/** Renders the app-wide right-click menu (see ContextMenuService). */
@Component({
  selector: 'app-context-menu',
  templateUrl: './context-menu.component.html',
  styleUrl: './context-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'menu.close()',
  },
})
export class ContextMenuComponent {
  readonly menu = inject(ContextMenuService);

  onBackdropContextMenu(event: Event): void {
    event.preventDefault();
    this.menu.close();
  }
}
