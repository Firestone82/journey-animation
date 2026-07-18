import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouteMapComponent } from './components/route-map/route-map.component';
import { ModeSwitcherComponent } from './components/mode-switcher/mode-switcher.component';
import { RouteSummaryComponent } from './components/route-summary/route-summary.component';
import { RouteBrowserComponent } from './components/route-browser/route-browser.component';
import { PlaybackControlsComponent } from './components/playback-controls/playback-controls.component';
import { JourneyLibraryComponent } from './components/journey-library/journey-library.component';
import { ThemeToggleComponent } from './components/theme-toggle/theme-toggle.component';

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
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {}
