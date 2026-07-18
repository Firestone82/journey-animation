import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-theme-toggle',
  templateUrl: './theme-toggle.component.html',
  styleUrl: './theme-toggle.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThemeToggleComponent {
  readonly theme = inject(ThemeService);

  readonly icon = computed(
    () => ({ auto: '◐', light: '☀', dark: '☾' })[this.theme.pref()],
  );
  readonly label = computed(
    () => ({ auto: 'Auto', light: 'Light', dark: 'Dark' })[this.theme.pref()],
  );
}
