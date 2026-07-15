/**
 * Casino Fighters — core game loop & Hi/Lo resolution.
 *
 * Flow: BETTING → (HI or LO) → RESOLVING (animations) → BETTING | GAME_OVER
 * Streak of 5 HI wins → triggerSpecialAttack() placeholder.
 */

import { GAME_PHASE, HEALTH, MULTIPLIER, STREAK, STAGE, TIMING } from './constants.js';
import { Fighter } from './fighter.js';
import { EffectsSystem } from './effects.js';
import { InputHandler } from './input.js';
import { Renderer } from './render.js';
import {
  assets,
  loadAssets,
  createPlayerAnimations,
  createOpponentAnimations,
} from './assets.js';
import { loadAudio, playKickSound, playPunchSound, unlockAudio } from './audio.js';
import { Fairness } from './fairness.js';

const ROUND_HISTORY_MAX = 16;

export class Game {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{
   *   btnHi: HTMLButtonElement,
   *   btnLo: HTMLButtonElement,
   *   btnRestart: HTMLButtonElement,
   *   overlay: HTMLElement,
   *   overlayTitle: HTMLElement,
   *   overlaySub: HTMLElement,
   *   streakEl: HTMLElement,
   *   roundHistoryEl?: HTMLElement,
   *   rtpPercentEl?: HTMLElement,
   *   rtpHashEl?: HTMLElement,
   *   rtpClientEl?: HTMLElement,
   *   rtpNonceEl?: HTMLElement,
   *   rtpLastEl?: HTMLElement,
   * }} ui
   */
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ui = ui;
    this.renderer = new Renderer(canvas);
    this.effects = new EffectsSystem();
    this.fairness = new Fairness();
    this.phase = GAME_PHASE.BETTING;
    this.streak = 0;
    this.round = 1;
    this.multiplier = MULTIPLIER.START;
    /** @type {Array<{ value: number, won: boolean }>} */
    this.multiplierHistory = [];
    /** @type {Array<'W' | 'L'>} */
    this.roundHistory = [];
    this.lastTime = 0;
    this.running = false;
    this._opponentDepleted = false;

    // Feet planted on the stone floor tiles
    this.player = new Fighter({
      name: 'YOU',
      x: STAGE.PLAYER_X,
      y: STAGE.FLOOR_Y,
      facing: 1,
      drawScale: STAGE.FIGHTER_SCALE,
      isPlayer: true,
    });

    this.opponent = new Fighter({
      name: 'CPU',
      x: STAGE.OPPONENT_X,
      y: STAGE.FLOOR_Y,
      facing: -1,
      drawScale: STAGE.OPPONENT_SCALE,
      isPlayer: false,
    });

    this.input = new InputHandler({
      onHi: () => this.placeBet('HI'),
      onLo: () => this.placeBet('LO'),
      onRestart: () => this.restart(),
    });
    this.input.bindUI(ui);

    window.addEventListener('resize', () => this.renderer.resize());
  }

  async init() {
    await Promise.all([loadAssets(), loadAudio(), this.fairness.initSession()]);
    if (!assets.playerFighter || !assets.opponentFighter) {
      throw new Error('Fighter sprites failed to load');
    }
    this.player.registerAnimations(
      createPlayerAnimations(assets.playerFighter, assets.playerKick)
    );
    this.opponent.registerAnimations(
      createOpponentAnimations(assets.opponentFighter, assets.opponentPunch)
    );
    // SOUND: start ambient / idle music loop here
    this._syncHud();
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this._frame(t));
  }

  /** @param {number} time */
  _frame(time) {
    if (!this.running) return;
    const dt = Math.min(50, time - this.lastTime);
    this.lastTime = time;

    this.player.update(dt);
    this.opponent.update(dt);
    this.effects.update(dt);

    this.renderer.draw({
      player: this.player,
      opponent: this.opponent,
      effects: this.effects,
      streak: this.streak,
      round: this.round,
      multiplier: this.multiplier,
      multiplierHistory: this.multiplierHistory,
    });

    requestAnimationFrame((t) => this._frame(t));
  }

  /**
   * @param {'HI' | 'LO'} choice
   */
  async placeBet(choice) {
    if (this.phase !== GAME_PHASE.BETTING) return;
    if (this.player.isBusy || this.opponent.isBusy) return;

    unlockAudio();
    this.phase = GAME_PHASE.RESOLVING;
    this.input.setEnabled(false);
    this._setButtonsDisabled(true);

    const { cardIsHigh } = await this.fairness.nextCard();
    const playerWon =
      (choice === 'HI' && cardIsHigh) || (choice === 'LO' && !cardIsHigh);

    this._lastCard = cardIsHigh ? 'HI' : 'LO';
    this._syncRtpUi();

    setTimeout(() => {
      if (playerWon) {
        this._resolveWin(choice);
      } else {
        this._resolveLoss();
      }
    }, TIMING.RESOLVE_DELAY);
  }

  /**
   * @param {'HI' | 'LO'} choice
   */
  _resolveWin(choice) {
    this._pushRoundHistory('W');

    if (choice === 'HI') {
      this.streak += 1;
    } else {
      this.streak = 0;
    }

    this.multiplier = Math.max(
      MULTIPLIER.START,
      this.multiplier * MULTIPLIER.WIN_FACTOR
    );
    this._pushMultiplierHistory(this.multiplier, true);
    this.effects.spawnMultiplierPopup(this.multiplier, true, {
      x: MULTIPLIER.POPUP_X,
      y: MULTIPLIER.POPUP_Y,
    });
    this._syncHud();

    this.player.playKickAttack(this.opponent.x, {
      onImpact: () => {
        playKickSound();
        this.opponent.takeDamage(HEALTH.WIN_COST);
        this.opponent.playHitReaction();

        this.effects.spawnSparks(this.opponent.x - 40, this.opponent.y - 180, 18);
        this.effects.spawnDamageNumber(
          this.opponent.x,
          this.opponent.y - 220,
          HEALTH.WIN_COST,
          'dealt'
        );
        this.effects.triggerFlash(0.45, 110);
        this.effects.triggerShake(8, 180);
      },
      onComplete: () => this._afterResolve(),
    });
  }

  _resolveLoss() {
    this._pushRoundHistory('L');
    this.streak = 0;
    if (this.multiplier > MULTIPLIER.START) {
      this._pushMultiplierHistory(this.multiplier, false);
      this.effects.spawnMultiplierPopup(this.multiplier, false, {
        x: MULTIPLIER.POPUP_X,
        y: MULTIPLIER.POPUP_Y,
      });
    }
    this.multiplier = MULTIPLIER.START;
    this._syncHud();

    this.opponent.playPunchAttack(this.player.x, {
      onImpact: () => {
        playPunchSound();
        this.player.takeDamage(HEALTH.WIN_COST);
        this.player.playHitReaction();

        this.effects.spawnSparks(this.player.x + 40, this.player.y - 160, 14);
        this.effects.spawnDamageNumber(
          this.player.x,
          this.player.y - 200,
          HEALTH.WIN_COST,
          'received'
        );
        this.effects.triggerFlash(0.35, 90);
        this.effects.triggerShake(7, 180);
      },
      onComplete: () => this._afterResolve(),
    });
  }

  _afterResolve() {
    if (this.player.health <= 0) {
      this._endMatch(false);
      return;
    }

    // Opponent boxes empty → hook for your next feature (no auto end-screen yet)
    if (this.opponent.health <= 0) {
      if (!this._opponentDepleted) {
        this._opponentDepleted = true;
        this.onOpponentBoxesDepleted();
      } else {
        this.round += 1;
        this._returnToBetting();
      }
      return;
    }

    this.round += 1;

    if (this.streak >= STREAK.SPECIAL_THRESHOLD && this.streak % STREAK.SPECIAL_THRESHOLD === 0) {
      this.triggerSpecialAttack();
      return;
    }

    this._returnToBetting();
  }

  /**
   * Called when the opponent's 5 yellow boxes are all gone.
   * Leave this for your follow-up event / KO / cash-out flow.
   */
  onOpponentBoxesDepleted() {
    // PLACEHOLDER — implement next beat here (ultra, jackpot, round clear, etc.)
    console.log('[Casino Fighters] Opponent boxes depleted — hook ready');
    this.effects.showSpecialBanner(1600);
    this.effects.triggerFlash(0.6, 220);
    this.effects.triggerShake(10, 280);
    // Keep fighting for now so you can wire the next step
    this.round += 1;
    this._returnToBetting();
  }

  /**
   * SPECIAL EVENT — called at 5 consecutive HI wins.
   * Implement your ultra move animation / damage here.
   */
  triggerSpecialAttack() {
    // Leave this function clear for you to expand into a full ultra.
    this.effects.showSpecialBanner(2000);
    this.effects.triggerFlash(0.8, 280);
    this.effects.triggerShake(14, 400);
    // SOUND: special charge / super flash SFX here

    this.player.playSpecial(() => {
      this.opponent.takeDamage(HEALTH.WIN_COST);
      this.opponent.playHitReaction(() => {
        this.effects.spawnSparks(this.opponent.x, this.opponent.y - 180, 28);
        this.effects.spawnDamageNumber(
          this.opponent.x,
          this.opponent.y - 240,
          HEALTH.WIN_COST,
          'dealt'
        );
        this.effects.triggerFlash(0.7, 180);
        this.effects.triggerShake(12, 300);

        if (this.opponent.health <= 0) {
          this.onOpponentBoxesDepleted();
          return;
        }
        this._returnToBetting();
      });
    });
  }

  /** @param {boolean} playerWon */
  _endMatch(playerWon) {
    this.phase = GAME_PHASE.GAME_OVER;
    this.input.setEnabled(false);
    this._setButtonsDisabled(true);

    this.ui.overlay.hidden = false;
    this.ui.overlay.classList.toggle('win', playerWon);
    this.ui.overlay.classList.toggle('lose', !playerWon);
    this.ui.overlayTitle.textContent = playerWon ? 'YOU WIN!' : 'YOU LOSE';
    this.ui.overlaySub.textContent = playerWon
      ? 'Opponent KO — Casino Fighters champion!'
      : 'Your HP hit zero. Press Restart to fight again.';
    // SOUND: win / lose jingle here
  }

  _returnToBetting() {
    // Ensure fighters aren't stuck busy if an anim edged a race
    if (this.player.state !== 'IDLE' && !this.player.motion) this.player.setIdle();
    if (this.opponent.state !== 'IDLE' && !this.opponent.motion) this.opponent.setIdle();

    this.phase = GAME_PHASE.BETTING;
    this.input.setEnabled(true);
    this._setButtonsDisabled(false);
  }

  restart() {
    this.player.reset();
    this.opponent.reset();
    this.streak = 0;
    this.round = 1;
    this.multiplier = MULTIPLIER.START;
    this.multiplierHistory = [];
    this.roundHistory = [];
    this._opponentDepleted = false;
    this.phase = GAME_PHASE.BETTING;
    this.effects.sparks = [];
    this.effects.floatTexts = [];
    this.effects.multiplierPopups = [];
    this.effects.flashes = [];
    this.effects.specialBanner.active = false;
    this.ui.overlay.hidden = true;
    this.fairness.initSession().then(() => this._syncHud());
    this._syncHud();
    this._returnToBetting();
  }

  /**
   * @param {number} value
   * @param {boolean} won
   */
  _pushMultiplierHistory(value, won) {
    this.multiplierHistory.unshift({ value, won });
    if (this.multiplierHistory.length > MULTIPLIER.HISTORY_MAX) {
      this.multiplierHistory.length = MULTIPLIER.HISTORY_MAX;
    }
  }

  /** @param {'W' | 'L'} result */
  _pushRoundHistory(result) {
    this.roundHistory.push(result);
    if (this.roundHistory.length > ROUND_HISTORY_MAX) {
      this.roundHistory.shift();
    }
  }

  _syncHud() {
    if (this.ui.streakEl) {
      this.ui.streakEl.textContent = String(this.streak);
    }
    this._syncRoundHistoryUi();
    this._syncRtpUi();
  }

  _syncRoundHistoryUi() {
    const el = this.ui.roundHistoryEl;
    if (!el) return;
    el.innerHTML = '';
    for (const result of this.roundHistory) {
      const chip = document.createElement('span');
      chip.className = `round-chip ${result === 'W' ? 'win' : 'lose'}`;
      chip.textContent = result;
      el.appendChild(chip);
    }
  }

  _syncRtpUi() {
    const f = this.fairness;
    if (this.ui.rtpPercentEl) this.ui.rtpPercentEl.textContent = `${f.rtpPercent}%`;
    if (this.ui.rtpHashEl) this.ui.rtpHashEl.textContent = f.shortHash();
    if (this.ui.rtpClientEl) this.ui.rtpClientEl.textContent = f.shortClient();
    if (this.ui.rtpNonceEl) this.ui.rtpNonceEl.textContent = String(f.nonce);
    if (this.ui.rtpLastEl) {
      this.ui.rtpLastEl.textContent =
        f.lastRoll == null
          ? '—'
          : `${f.lastRoll.toFixed(4)} → ${f.lastOutcome}`;
    }
  }

  /** @param {boolean} disabled */
  _setButtonsDisabled(disabled) {
    this.ui.btnHi.disabled = disabled;
    this.ui.btnLo.disabled = disabled;
  }
}
