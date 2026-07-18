import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TRAVEL_MODES } from '../../core/travel-modes';
import { TripService } from '../../services/trip.service';

@Component({
  selector: 'app-mode-switcher',
  templateUrl: './mode-switcher.component.html',
  styleUrl: './mode-switcher.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModeSwitcherComponent {
  readonly trip = inject(TripService);
  readonly modes = TRAVEL_MODES;
}
