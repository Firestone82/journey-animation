import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TripService } from '../../services/trip.service';
import { metresToKm } from '../../core/format';

@Component({
  selector: 'app-playback-controls',
  imports: [DecimalPipe],
  templateUrl: './playback-controls.component.html',
  styleUrl: './playback-controls.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaybackControlsComponent {
  readonly trip = inject(TripService);
  readonly speeds = [0.5, 1, 2, 4];
  readonly km = metresToKm;
}
