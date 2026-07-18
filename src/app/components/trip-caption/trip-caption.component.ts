import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TripService } from '../../services/trip.service';

@Component({
  selector: 'app-trip-caption',
  templateUrl: './trip-caption.component.html',
  styleUrl: './trip-caption.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TripCaptionComponent {
  readonly trip = inject(TripService);
}
