import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { CameraMode, TripService } from '../../services/trip.service';
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
  readonly cameras: { id: CameraMode; label: string }[] = [
    { id: 'off', label: 'Off' },
    { id: 'follow', label: 'Follow' },
    { id: 'cinematic', label: 'Cinematic' },
  ];
  readonly km = metresToKm;
}
