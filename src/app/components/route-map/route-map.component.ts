import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core';
import { TripService } from '../../services/trip.service';
import { TripCaptionComponent } from '../trip-caption/trip-caption.component';

@Component({
  selector: 'app-route-map',
  imports: [TripCaptionComponent],
  templateUrl: './route-map.component.html',
  styleUrl: './route-map.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RouteMapComponent implements AfterViewInit, OnDestroy {
  @ViewChild('map', { static: true }) mapEl!: ElementRef<HTMLDivElement>;

  private readonly trip = inject(TripService);

  ngAfterViewInit(): void {
    this.trip.attachMap(this.mapEl.nativeElement);
  }

  ngOnDestroy(): void {
    this.trip.detachMap();
  }
}
