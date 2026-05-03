import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { getTechReadinessRankings, type TechReadinessScore } from '@/services/economic';
import { escapeHtml } from '@/utils/sanitize';

const COUNTRY_FLAGS: Record<string, string> = {
  'USA': '🇺🇸', 'CHN': '🇨🇳', 'JPN': '🇯🇵', 'DEU': '🇩🇪', 'KOR': '🇰🇷',
  'GBR': '🇬🇧', 'IND': '🇮🇳', 'ISR': '🇮🇱', 'SGP': '🇸🇬', 'TWN': '🇹🇼',
  'FRA': '🇫🇷', 'CAN': '🇨🇦', 'SWE': '🇸🇪', 'NLD': '🇳🇱', 'CHE': '🇨🇭',
  'FIN': '🇫🇮', 'IRL': '🇮🇪', 'AUS': '🇦🇺', 'BRA': '🇧🇷', 'IDN': '🇮🇩',
  'ESP': '🇪🇸', 'ITA': '🇮🇹', 'MEX': '🇲🇽', 'RUS': '🇷🇺', 'TUR': '🇹🇷',
  'SAU': '🇸🇦', 'ARE': '🇦🇪', 'POL': '🇵🇱', 'THA': '🇹🇭', 'MYS': '🇲🇾',
  'VNM': '🇻🇳', 'PHL': '🇵🇭', 'NZL': '🇳🇿', 'AUT': '🇦🇹', 'BEL': '🇧🇪',
  'DNK': '🇩🇰', 'NOR': '🇳🇴', 'PRT': '🇵🇹', 'CZE': '🇨🇿', 'ZAF': '🇿🇦',
  'NGA': '🇳🇬', 'KEN': '🇰🇪', 'EGY': '🇪🇬', 'ARG': '🇦🇷', 'CHL': '🇨🇱',
  'COL': '🇨🇴', 'PAK': '🇵🇰', 'BGD': '🇧🇩', 'UKR': '🇺🇦', 'ROU': '🇷🇴',
  'EST': '🇪🇪', 'LVA': '🇱🇻', 'LTU': '🇱🇹', 'HUN': '🇭🇺', 'GRC': '🇬🇷',
  'QAT': '🇶🇦', 'BHR': '🇧🇭', 'KWT': '🇰🇼', 'OMN': '🇴🇲', 'JOR': '🇯🇴',
};

export class TechReadinessPanel extends Panel {
  private rankings: TechReadinessScore[] = [];
  private loading = false;
  private lastFetch = 0;
  private readonly REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
  /**
   * Backoff timer for retrying after an empty/failed fetch. Without this,
   * a single transient blip (slow-tier bootstrap abort + lazy-fetch fail)
   * left the panel stuck in an empty/error state until the user restarted
   * the app — refresh() is only fired at startup.
   */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private emptyRetryAttempt = 0;
  private readonly MAX_RETRY_ATTEMPTS = 5;

  constructor() {
    super({
      id: 'tech-readiness',
      title: t('panels.techReadiness'),
      showCount: true,
      infoTooltip: t('components.techReadiness.infoTooltip'),
    });
  }

  public async refresh(): Promise<void> {
    if (this.loading) return;
    if (Date.now() - this.lastFetch < this.REFRESH_INTERVAL && this.rankings.length > 0) {
      return;
    }

    this.loading = true;
    this.clearRetryTimer();
    this.showFetchingState();

    try {
      const result = await getTechReadinessRankings();
      if (!this.element?.isConnected) return;
      this.rankings = result;
      this.setCount(result.length);
      if (result.length === 0) {
        // Server returned an empty payload (NOT a network failure — those
        // throw and land in the catch branch). Show a soft "refreshing"
        // state and retry on backoff in case the seed-meta is briefly out
        // of step with the underlying data key, instead of painting the
        // panel red as a hard error. Don't stamp lastFetch — we want
        // explicit retries, not a 6h cooldown on no data.
        this.showSoftRefreshing();
        this.scheduleRetry();
        return;
      }
      this.lastFetch = Date.now();
      this.emptyRetryAttempt = 0;
      this.render();
    } catch (error) {
      if (!this.element?.isConnected) return;
      console.error('[TechReadinessPanel] Error fetching data:', error);
      // Pass an onRetry callback so Panel.showError renders an auto-retry
      // countdown with exponential backoff (15s, 30s, 60s, ...). Previously
      // the error state had no retry path at all — once it failed, the user
      // had to restart the app to recover.
      this.showError(t('common.failedTechReadiness'), () => void this.refresh());
    } finally {
      this.loading = false;
    }
  }

  override destroy(): void {
    this.clearRetryTimer();
    super.destroy();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(): void {
    if (this.emptyRetryAttempt >= this.MAX_RETRY_ATTEMPTS) return;
    // 30s → 60s → 2m → 4m → 5m (capped). Bounded so we don't hammer an
    // upstream that's genuinely down, but quick enough that a user who
    // tripped over a transient blip recovers without restarting the app.
    const delays = [30_000, 60_000, 120_000, 240_000, 300_000];
    const delay = delays[this.emptyRetryAttempt] ?? 300_000;
    this.emptyRetryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh();
    }, delay);
  }

  private showSoftRefreshing(): void {
    // Soft empty state — distinct from showError() so the panel header
    // doesn't paint red on a benign empty payload. Caller schedules an
    // auto-retry; this is just the visual placeholder while we wait.
    this.setContent(`
      <div class="panel-soft-empty" style="padding:24px 16px;color:var(--text-dim);font-size:12px;text-align:center;line-height:1.5">
        <div style="font-size:20px;margin-bottom:8px">⌛</div>
        <div>${escapeHtml(t('components.techReadiness.dataPreparing'))}</div>
      </div>
    `);
  }

  private showFetchingState(): void {
    this.setContent(`
      <div class="tech-fetch-progress">
        <div class="tech-fetch-icon">
          <div class="tech-globe-ring"></div>
          <span class="tech-globe">🌐</span>
        </div>
        <div class="tech-fetch-title">${t('components.techReadiness.fetchingData')}</div>
        <div class="tech-fetch-indicators">
          <div class="tech-indicator-item" style="animation-delay: 0s">
            <span class="tech-indicator-icon">🌐</span>
            <span class="tech-indicator-name">${t('components.techReadiness.internetUsersIndicator')}</span>
            <span class="tech-indicator-status"></span>
          </div>
          <div class="tech-indicator-item" style="animation-delay: 0.2s">
            <span class="tech-indicator-icon">📱</span>
            <span class="tech-indicator-name">${t('components.techReadiness.mobileSubscriptionsIndicator')}</span>
            <span class="tech-indicator-status"></span>
          </div>
          <div class="tech-indicator-item" style="animation-delay: 0.4s">
            <span class="tech-indicator-icon">📡</span>
            <span class="tech-indicator-name">${t('components.techReadiness.broadbandAccess')}</span>
            <span class="tech-indicator-status"></span>
          </div>
          <div class="tech-indicator-item" style="animation-delay: 0.6s">
            <span class="tech-indicator-icon">🔬</span>
            <span class="tech-indicator-name">${t('components.techReadiness.rdExpenditure')}</span>
            <span class="tech-indicator-status"></span>
          </div>
        </div>
        <div class="tech-fetch-note">${t('components.techReadiness.analyzingCountries')}</div>
      </div>
    `);
  }

  private getFlag(countryCode: string): string {
    return COUNTRY_FLAGS[countryCode] || '🌐';
  }

  private getScoreClass(score: number): string {
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  private formatComponent(value: number | null): string {
    if (value === null) return '—';
    return Math.round(value).toString();
  }

  private render(): void {
    // Empty-result branch was removed: refresh() now routes empty payloads
    // through showSoftRefreshing() + scheduleRetry() and only calls render()
    // when there's data to show. Painting "no data available" via
    // showError() flipped the panel into red error styling and gave the
    // user no recovery path on a benign empty payload.
    const top = this.rankings.slice(0, 25);

    const html = `
      <div class="tech-readiness-list">
        ${top.map(country => {
      const scoreClass = this.getScoreClass(country.score);
      return `
            <div class="readiness-item ${scoreClass}" data-country="${escapeHtml(country.country)}">
              <div class="readiness-rank">#${country.rank}</div>
              <div class="readiness-flag">${this.getFlag(country.country)}</div>
              <div class="readiness-info">
                <div class="readiness-name">${escapeHtml(country.countryName)}</div>
                <div class="readiness-components">
                  <span title="${t('components.techReadiness.internetUsers')}">🌐${this.formatComponent(country.components.internet)}</span>
                  <span title="${t('components.techReadiness.mobileSubscriptions')}">📱${this.formatComponent(country.components.mobile)}</span>
                  <span title="${t('components.techReadiness.rdSpending')}">🔬${this.formatComponent(country.components.rdSpend)}</span>
                </div>
              </div>
              <div class="readiness-score ${scoreClass}">${country.score}</div>
            </div>
          `;
    }).join('')}
      </div>
      <div class="readiness-footer">
        <span class="readiness-source">${t('components.techReadiness.source')}</span>
        <span class="readiness-updated">${t('components.techReadiness.updated', { date: new Date(this.lastFetch).toLocaleDateString() })}</span>
      </div>
    `;

    this.setContent(html);
  }
}
