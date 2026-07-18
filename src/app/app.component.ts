import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouteMapComponent } from './components/route-map/route-map.component';
import { ModeSwitcherComponent } from './components/mode-switcher/mode-switcher.component';
import { RouteSummaryComponent } from './components/route-summary/route-summary.component';
import { RouteBrowserComponent } from './components/route-browser/route-browser.component';
import { PlaybackControlsComponent } from './components/playback-controls/playback-controls.component';
import { JourneyLibraryComponent } from './components/journey-library/journey-library.component';
import { ThemeToggleComponent } from './components/theme-toggle/theme-toggle.component';
import { ContextMenuComponent } from './components/context-menu/context-menu.component';
import { TripService } from './services/trip.service';

@Component({
  selector: 'app-root',
  imports: [
    RouteMapComponent,
    ModeSwitcherComponent,
    RouteSummaryComponent,
    RouteBrowserComponent,
    PlaybackControlsComponent,
    JourneyLibraryComponent,
    ThemeToggleComponent,
    ContextMenuComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class AppComponent {
  private readonly trip = inject(TripService);

  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.trip.redo();
      else this.trip.undo();
    } else if (key === 'y') {
      event.preventDefault();
      this.trip.redo();
    }
  }
}
