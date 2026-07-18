import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TripService } from '../../services/trip.service';
import { formatDuration, metresToKm } from '../../core/format';

@Component({
  selector: 'app-route-summary',
  imports: [DecimalPipe],
  templateUrl: './route-summary.component.html',
  styleUrl: './route-summary.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RouteSummaryComponent {
  readonly trip = inject(TripService);
  readonly km = metresToKm;
  readonly fmtDuration = formatDuration;
}
