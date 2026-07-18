import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouteMapComponent } from './components/route-map/route-map.component';
import { ModeSwitcherComponent } from './components/mode-switcher/mode-switcher.component';
import { RouteSummaryComponent } from './components/route-summary/route-summary.component';
import { PlaybackControlsComponent } from './components/playback-controls/playback-controls.component';

@Component({
  selector: 'app-root',
  imports: [
    RouteMapComponent,
    ModeSwitcherComponent,
    RouteSummaryComponent,
    PlaybackControlsComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {}
