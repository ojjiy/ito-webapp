const FIREBASE_APP_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
const FIREBASE_STORE_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
const FIREBASE_APP_CHECK_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-check.js";

const ROOM_ID_MAX_ATTEMPTS = 8;
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRESENCE_HEARTBEAT_MS = 30 * 1000;
const HOST_STALE_MS = 90 * 1000;

const PHASE_LABELS = {
  lobby: "ロビー",
  theme: "お題",
  writing: "ワード入力",
  submit: "提出",
  submitReview: "結果確認",
  vote: "うっかり投票",
  roundEnd: "投票結果",
  gameOver: "最終結果"
};

const DEFAULT_SETTINGS = {
  maxRounds: 3,
  initialLife: 3,
  cardIncrement: 1,
  cardLimit: 5,
  sortMode: "pattern1",
  pattern1LifeRule: "flat",
  pattern2LifeRule: "skipped",
  culpritTokens: true,
  inputVisibility: "afterWriting"
};

const appState = {
  roomId: getRoomIdFromUrl(),
  playerId: null,
  hostKey: null,
  room: null,
  missingRoom: false,
  store: null,
  syncMode: "local",
  loading: false,
  settingsSaveTimer: null,
  presenceTimer: null,
  lastPresenceUpdateAt: 0,
  autoHostClaimInFlight: false,
  notice: "",
  error: "",
  nameDraft: "",
  textDrafts: {}
};

const root = document.querySelector("#app");

class RoomIdCollisionError extends Error {
  constructor(roomId) {
    super(`ルームID ${roomId} は既に使われています。`);
    this.name = "RoomIdCollisionError";
  }
}

class RoomStore {
  constructor({ onRoom, onMissing, onMode, onError }) {
    this.onRoom = onRoom;
    this.onMissing = onMissing;
    this.onMode = onMode;
    this.onError = onError;
    this.mode = "local";
    this.roomId = null;
    this.room = null;
    this.unsubscribe = null;
    this.storageHandler = null;
    this.db = null;
    this.fs = null;
  }

  async init() {
    const config = window.ITO_FIREBASE_CONFIG;
    if (!config || !config.apiKey || !config.projectId) {
      this.setMode("local");
      return;
    }
    const { appCheckSiteKey, ...firebaseConfig } = config;

    try {
      const [{ initializeApp }, firestore, appCheck] = await Promise.all([
        import(FIREBASE_APP_URL),
        import(FIREBASE_STORE_URL),
        import(FIREBASE_APP_CHECK_URL)
      ]);
      const firebaseApp = initializeApp(firebaseConfig);

      if (appCheckSiteKey) {
        appCheck.initializeAppCheck(firebaseApp, {
          provider: new appCheck.ReCaptchaEnterpriseProvider(appCheckSiteKey),
          isTokenAutoRefreshEnabled: true
        });
      }

      this.db = firestore.getFirestore(firebaseApp);
      this.fs = firestore;
      this.setMode("firebase");
    } catch (error) {
      this.setMode("local");
      this.onError("Firebaseに接続できないため、ローカル動作に切り替えました。");
      console.error(error);
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.onMode(mode);
  }

  async create(room) {
    const normalized = normalizeRoom(room);

    if (this.mode === "firebase") {
      const ref = this.fs.doc(this.db, "rooms", normalized.id);
      await this.fs.runTransaction(this.db, async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists()) throw new RoomIdCollisionError(normalized.id);
        transaction.set(ref, normalized);
      });
    } else {
      if (readLocalRoom(normalized.id)) throw new RoomIdCollisionError(normalized.id);
      writeLocalRoom(normalized);
    }

    this.roomId = normalized.id;
    await this.connect(normalized.id);
  }

  async connect(roomId) {
    this.disconnect();
    this.roomId = roomId;

    if (this.mode === "firebase") {
      const ref = this.fs.doc(this.db, "rooms", roomId);
      this.unsubscribe = this.fs.onSnapshot(
        ref,
        (snapshot) => {
          if (!snapshot.exists()) {
            this.room = null;
            this.onMissing(true);
            this.onRoom(null);
            return;
          }
          this.room = normalizeRoom(snapshot.data());
          this.onMissing(false);
          this.onRoom(this.room);
        },
        (error) => {
          this.onError("ルームを読み込めませんでした。");
          console.error(error);
        }
      );
      return;
    }

    this.room = readLocalRoom(roomId);
    this.onMissing(!this.room);
    this.onRoom(this.room);
    this.storageHandler = (event) => {
      if (event.key !== localRoomKey(roomId)) return;
      this.room = readLocalRoom(roomId);
      this.onMissing(!this.room);
      this.onRoom(this.room);
    };
    window.addEventListener("storage", this.storageHandler);
  }

  disconnect() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.storageHandler) {
      window.removeEventListener("storage", this.storageHandler);
      this.storageHandler = null;
    }
  }

  async update(mutator) {
    if (!this.roomId) throw new Error("ルームが選択されていません。");

    if (this.mode === "firebase") {
      const ref = this.fs.doc(this.db, "rooms", this.roomId);
      await this.fs.runTransaction(this.db, async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) throw new Error("ルームが見つかりません。");
        const current = normalizeRoom(snapshot.data());
        const next = mutator(deepCopy(current));
        if (!next) return;
        next.updatedAt = nowIso();
        next.expiresAt = expirationDateFromNow();
        transaction.set(ref, normalizeRoom(next));
      });
      return;
    }

    const current = readLocalRoom(this.roomId);
    if (!current) throw new Error("ルームが見つかりません。");
    const next = mutator(deepCopy(current));
    if (!next) return;
    next.updatedAt = nowIso();
    next.expiresAt = expirationDateFromNow();
    this.room = normalizeRoom(next);
    writeLocalRoom(this.room);
    this.onMissing(false);
    this.onRoom(this.room);
  }
}

async function boot() {
  appState.store = new RoomStore({
    onRoom: (room) => {
      appState.room = room;
      if (room && appState.playerId && !room.players.some((player) => player.id === appState.playerId)) {
        appState.playerId = null;
        clearPlayerId(room.id);
      }
      pruneWritingDrafts(room);
      syncPresence(room);
      render();
    },
    onMissing: (missing) => {
      appState.missingRoom = missing;
      if (missing) stopPresenceHeartbeat();
      render();
    },
    onMode: (mode) => {
      appState.syncMode = mode;
      render();
    },
    onError: setError
  });

  await appState.store.init();
  restoreClientKeys(appState.roomId);
  if (appState.roomId) {
    await appState.store.connect(appState.roomId);
  }
  render();
}

function render() {
  const activeInput = captureWritingInputFocus();
  root.replaceChildren(
    appShell(
      appState.room ? renderRoom() : renderEntry()
    )
  );
  restoreWritingInputFocus(activeInput);
  scrollSubmissionTracksToEnd();
}

function captureWritingInputFocus() {
  const active = document.activeElement;
  if (!active || active.tagName !== "INPUT" || !active.closest(".card-input-list")) return null;
  return {
    name: active.name,
    selectionStart: active.selectionStart,
    selectionEnd: active.selectionEnd
  };
}

function restoreWritingInputFocus(activeInput) {
  if (!activeInput || !activeInput.name) return;
  const input = Array.from(document.querySelectorAll(".card-input-list input"))
    .find((item) => item.name === activeInput.name && !item.disabled);
  if (!input) return;

  input.focus({ preventScroll: true });
  if (typeof input.setSelectionRange === "function") {
    const start = activeInput.selectionStart ?? input.value.length;
    const end = activeInput.selectionEnd ?? start;
    input.setSelectionRange(start, end);
  }
}

function scrollSubmissionTracksToEnd() {
  requestAnimationFrame(() => {
    document.querySelectorAll(".submission-track").forEach((track) => {
      track.scrollLeft = track.scrollWidth;
    });
  });
}

function appShell(content) {
  const room = appState.room;
  const phase = room ? PHASE_LABELS[room.phase] : "未接続";
  const roomText = room ? `#${room.id}` : "未接続";
  const shareUrl = room ? getShareUrl(room.id) : "";
  const localShareWarning =
    appState.syncMode === "local"
      ? "Local: 同じブラウザの別タブで確認できます。"
      : "";

  return el(
    "div",
    { class: "app-frame" },
    el(
      "header",
      { class: "topbar" },
      el("div", { class: "brand" }, el("span", { class: "brand-mark" }, "ito"), el("span", {}, "ito")),
      el(
        "div",
        { class: "topbar-meta" },
        pill(appState.syncMode === "firebase" ? "Firebase" : "Local", appState.syncMode === "firebase" ? "ok" : "warn"),
        room
          ? button(roomText, () => copyText(shareUrl), "pilllike muted", { title: "URLをコピー" })
          : pill(roomText, "muted"),
        pill(phase, "info"),
        room ? button("URL", () => copyText(shareUrl), "secondary compact") : null,
        room ? button("退出", leaveCurrentRoom, "ghost compact") : null
      )
    ),
    appState.error ? el("div", { class: "banner error" }, appState.error) : null,
    appState.notice ? el("div", { class: "banner notice" }, appState.notice) : null,
    localShareWarning ? el("div", { class: "banner warning" }, localShareWarning) : null,
    room && room.roomMessage ? el("div", { class: "banner notice" }, room.roomMessage) : null,
    content
  );
}

function renderEntry() {
  if (appState.roomId && appState.missingRoom) {
    return el(
      "main",
      { class: "layout narrow" },
      panel("ルームが見つかりません", [
        el("p", { class: "muted-text" }, `ID: ${appState.roomId}`),
        appState.syncMode === "local"
          ? el("p", { class: "muted-text" }, "Local のルームは同じブラウザ内だけで共有されます。")
          : null,
        button("戻る", () => leaveRoomUrl(), "secondary")
      ])
    );
  }

  return el(
    "main",
    { class: "layout home-layout" },
    el(
      "div",
      { class: "home-actions" },
      el(
        "article",
        { class: "home-tile home-create-tile" },
        el(
          "div",
          { class: "home-create-box" },
          button("部屋を作る", createRoom, "primary calm-blue")
        )
      ),
      el(
        "form",
        { class: "home-tile home-enter-tile", onsubmit: handleRoomJoin },
        el(
          "div",
          { class: "home-join-box" },
          el("label", { class: "sr-only", for: "home-room-id" }, "ルームID"),
          el("input", { id: "home-room-id", name: "roomId", maxlength: "12", autocomplete: "off", placeholder: "ルームID", required: true }),
          button("部屋に入る", null, "primary", { type: "submit" })
        )
      )
    )
  );
}

function renderRoom() {
  const room = appState.room;
  const player = getCurrentPlayer();
  if (!player) return renderNameRegistration();

  const views = {
    lobby: renderLobby,
    theme: renderTheme,
    writing: renderWriting,
    submit: renderSubmit,
    submitReview: renderSubmitReview,
    vote: renderVote,
    roundEnd: renderRoundEnd,
    gameOver: renderGameOver
  };
  const phaseView = views[room.phase] ? views[room.phase]() : panel("不明なフェーズ", [el("p", {}, room.phase)]);
  const showSidePanel = room.phase !== "gameOver";

  return el(
    "main",
    { class: "layout" },
    renderRoomSummary(),
    showSidePanel
      ? el(
          "div",
          { class: "play-layout" },
          el("div", { class: "play-main" }, phaseView),
          renderSidePanel()
        )
      : phaseView
  );
}

function renderNameRegistration() {
  const room = appState.room;
  return el(
    "main",
    { class: "layout narrow" },
    panel("名前を登録", [
      el("p", { class: "muted-text" }, `#${room.id}`),
      el(
        "form",
        { class: "stack", onsubmit: handleNameSubmit },
        label(
          "名前",
          el("input", {
            name: "name",
            maxlength: "24",
            autocomplete: "name",
            value: appState.nameDraft,
            oninput: handleNameDraftInput,
            required: true
          })
        ),
        button("参加", null, "primary", { type: "submit" })
      )
    ])
  );
}

function renderRoomSummary() {
  const room = appState.room;
  const displayedRound = room.currentRound ? room.currentRound.roundNumber : room.round;

  return el(
    "section",
    { class: "summary-band" },
    el(
      "div",
      { class: "summary-grid" },
      lifeMetric(room.life),
      metric("ラウンド", `${displayedRound}/${room.settings.maxRounds}`)
    )
  );
}

function lifeMetric(value) {
  const maxVisibleHearts = 8;
  const visible = Math.max(0, Math.min(value, maxVisibleHearts));
  return el(
    "div",
    { class: "metric life-metric" },
    el("span", {}, "ライフ"),
    el(
      "div",
      { class: "life-row", "aria-label": `ライフ ${value}` },
      el("div", { class: "heart-list" }, ...Array.from({ length: visible }, () => heartIcon())),
      value > maxVisibleHearts ? el("strong", { class: "life-count" }, `x${value}`) : null,
      value <= 0 ? el("strong", { class: "life-count" }, "0") : null
    )
  );
}

function heartIcon() {
  return el(
    "svg",
    { class: "heart-icon", viewBox: "0 0 24 24", "aria-hidden": "true" },
    el("path", {
      d: "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
    })
  );
}

function renderSidePanel() {
  const room = appState.room;
  const player = getCurrentPlayer();
  const settings = room.settings;
  const isLobby = room.phase === "lobby";

  return el(
    "aside",
    { class: "side-panel" },
    el(
      "section",
      { class: "side-section" },
      el("h2", {}, "あなた"),
      el("p", { class: "side-value" }, player ? player.name : "-"),
      isHost() ? el("div", { class: "side-pills" }, pill("ホスト", "ok")) : null,
      player && !isHost() ? button("ホストを引き継ぐ", claimHost, "secondary compact") : null
    ),
    el(
      "section",
      { class: "side-section" },
      el("h2", {}, "メンバー"),
      el(
        "div",
        { class: "side-player-list" },
        ...room.players.map((item) => {
          const isSpectator = room.currentRound && !isRoundParticipant(room, room.currentRound, item.id);
          return el(
            "div",
            { class: "side-player" },
            el(
              "div",
              { class: "side-player-head" },
              el("span", {}, item.name),
              el(
                "div",
                { class: "side-player-actions" },
                isPlayerHost(room, item.id) ? pill("ホスト", "ok") : null,
                isSpectator ? pill("閲覧", "muted") : null,
                canRemovePlayer(item.id) ? button("削除", () => removePlayer(item.id), "ghost compact", { title: `${item.name}を削除` }) : null
              )
            ),
            el("small", {}, `うっかり票 ${item.culpritTokens || 0}`)
          );
        })
      )
    ),
    isLobby
      ? el(
          "section",
          { class: "side-section" },
          renderLobbyActions()
        )
      : null,
    isLobby
      ? null
      : el(
          "section",
          { class: "side-section" },
          el("h2", {}, "ルール"),
          renderRuleList([
            ["ラウンド", `${settings.maxRounds}`],
            ["ライフ", `${settings.initialLife}`],
            ["追加", `${settings.cardIncrement}`],
            ["手札上限", `${settings.cardLimit}`],
            ["提出方式", sortModeLabel(settings.sortMode)],
            ["失敗時", lifeRuleLabel(settings)],
            ["うっかり投票", settings.culpritTokens ? "あり" : "なし"],
            ["ワード公開", inputVisibilityLabel(settings.inputVisibility)]
          ])
        )
  );
}

function renderRuleList(items) {
  return el(
    "dl",
    { class: "rule-list" },
    ...items.flatMap(([labelText, value]) => [
      el("dt", {}, labelText),
      el("dd", {}, value)
    ])
  );
}

function themeHero(roundNumber, theme) {
  return el(
    "div",
    { class: "round-hero" },
    el("span", {}, `ラウンド ${roundNumber}`),
    el("strong", {}, theme)
  );
}

function renderLobby() {
  return panel("ルール設定", [renderSettingsForm()]);
}

function renderSettingsForm() {
  const settings = appState.room.settings;
  const disabled = !isHost();
  const isPattern1 = settings.sortMode !== "pattern2";
  const isPattern2 = settings.sortMode === "pattern2";

  return el(
    "form",
    { class: "settings-grid", onchange: handleSettingsChange, onsubmit: preventFormSubmit },
    label("ラウンド", el("input", { type: "number", name: "maxRounds", min: "1", max: "20", value: settings.maxRounds, disabled, required: true })),
    label("ライフ", el("input", { type: "number", name: "initialLife", min: "1", max: "30", value: settings.initialLife, disabled, required: true })),
    label("追加手札", el("input", { type: "number", name: "cardIncrement", min: "1", max: "20", value: settings.cardIncrement, disabled, required: true })),
    label("手札上限", el("input", { type: "number", name: "cardLimit", min: "1", max: "100", value: settings.cardLimit, disabled, required: true })),
    el(
      "fieldset",
      { class: "field-span" },
      el("legend", {}, "提出方式"),
      radio("sortMode", "pattern1", "1枚ずつ提出", settings.sortMode === "pattern1", disabled),
      radio("sortMode", "pattern2", "全カード一括", settings.sortMode === "pattern2", disabled)
    ),
    el(
      "fieldset",
      { class: `field-span ${isPattern1 ? "" : "inactive"}` },
      el("legend", {}, "1枚ずつ提出: 失敗時のライフ"),
      radio("pattern1LifeRule", "flat", "一律 -1", settings.pattern1LifeRule === "flat", disabled || !isPattern1),
      radio("pattern1LifeRule", "skipped", "飛ばした枚数分", settings.pattern1LifeRule === "skipped", disabled || !isPattern1)
    ),
    el(
      "fieldset",
      { class: `field-span ${isPattern2 ? "" : "inactive"}` },
      el("legend", {}, "全カード一括: 失敗時のライフ"),
      radio("pattern2LifeRule", "skipped", "飛ばされたカード枚数分", settings.pattern2LifeRule === "skipped", disabled || !isPattern2),
      radio("pattern2LifeRule", "moved", "最小移動枚数分", settings.pattern2LifeRule === "moved", disabled || !isPattern2)
    ),
    el(
      "fieldset",
      { class: "field-span" },
      el("legend", {}, "ワードの公開"),
      radio("inputVisibility", "afterWriting", "全員入力後", settings.inputVisibility === "afterWriting", disabled),
      radio("inputVisibility", "live", "入力中も表示", settings.inputVisibility === "live", disabled)
    ),
    label(
      "うっかり投票",
      el(
        "select",
        { name: "culpritTokens", disabled },
        option("true", "あり", settings.culpritTokens),
        option("false", "なし", !settings.culpritTokens)
      )
    )
  );
}

function renderLobbyActions() {
  const canStart = isHost() && appState.room.players.length > 0;
  return el(
    "div",
    { class: "action-row" },
    isHost() ? button("開始", startGame, "primary", { disabled: !canStart }) : el("p", { class: "muted-text" }, "ホストの開始待ち")
  );
}

function renderPlayerList(extraClass = "") {
  const room = appState.room;
  return el(
    "div",
    { class: `player-list ${extraClass}` },
    ...room.players.map((player) =>
      el(
        "div",
        { class: "player-row" },
        el("span", { class: "player-name" }, player.name),
        el(
          "div",
          { class: "player-row-meta" },
          isPlayerHost(room, player.id) ? pill("ホスト", "ok") : null,
          el("span", { class: "player-meta" }, `うっかり票 ${player.culpritTokens || 0}`),
          canRemovePlayer(player.id) ? button("削除", () => removePlayer(player.id), "ghost compact", { title: `${player.name}を削除` }) : null
        )
      )
    )
  );
}

function renderTheme() {
  const nextRound = appState.room.round + 1;
  return panel(`ラウンド ${nextRound}`, [
    isHost()
      ? el(
          "form",
          { class: "stack", onsubmit: handleThemeSubmit },
          label("お題", el("input", { name: "theme", maxlength: "80", required: true, autofocus: true, placeholder: "雨の日の楽しみ" })),
          button("カードを配る", null, "primary", { type: "submit" })
        )
      : el("p", { class: "muted-text" }, "ホストのお題待ち")
  ]);
}

function renderWriting() {
  const round = appState.room.currentRound;
  const ownCards = getOwnActiveRoundCards();
  const ownReady = ownCards.length > 0 && ownCards.every((card) => card.text.trim().length > 0);
  const allReady = round.cards.every((card) => card.text.trim().length > 0);
  const isParticipant = isRoundParticipant(appState.room, round, appState.playerId);

  return el(
    "div",
    { class: "content-grid" },
    panel("ワードを書く", [
      themeHero(round.roundNumber, round.theme),
      el(
        "form",
        { class: "card-input-list", onsubmit: handleTextSubmit },
        ...ownCards.map((card, index) =>
          el(
            "div",
            { class: "number-card own" },
            el(
              "div",
              { class: "number-card-head" },
              el("span", {}, `#${index + 1}`),
              el("strong", { class: "card-number-chip graded", style: cardNumberStyle(card.number) }, String(card.number))
            ),
            label(
              "この数字を表すワード",
              el("input", {
                name: card.id,
                maxlength: "80",
                value: getWritingDraftValue(card),
                placeholder: "短いワードで表す",
                disabled: ownReady,
                required: true,
                oninput: handleWritingDraftInput
              })
            )
          )
        ),
        ownCards.length
          ? button(ownReady ? "記入済み" : "保存", null, "primary", { type: "submit", disabled: ownReady })
          : el("p", { class: "muted-text" }, isParticipant ? "手札がありません" : "このラウンドは閲覧のみです")
      )
    ]),
    panel("入力状況", [
      renderInputProgress(),
      el("p", { class: "muted-text microcopy" }, allReady ? "全員入力済み" : "入力待ち")
    ])
  );
}

function renderInputProgress() {
  const round = appState.room.currentRound;
  const players = getRoundPlayers(appState.room, round);
  return el(
    "div",
    { class: "player-list" },
    ...players.map((player) => {
      const cards = round.cards.filter((card) => card.playerId === player.id);
      const ready = cards.length > 0 && cards.every((card) => card.text.trim().length > 0);
      return el(
        "div",
        { class: "player-row" },
        el(
          "div",
          { class: "player-progress" },
          el("span", { class: "player-name" }, player.name),
          renderVisibleInputTexts(cards)
        ),
        pill(ready ? "入力済み" : "未入力", ready ? "ok" : "warn")
      );
    })
  );
}

function renderVisibleInputTexts(cards) {
  if (appState.room.settings.inputVisibility !== "live") return null;
  return el(
    "div",
    { class: "input-preview-list" },
    ...cards.map((card, index) =>
      el(
        "div",
        { class: `input-preview-card ${card.text ? "" : "empty"}` },
        el("span", {}, `#${index + 1}`),
        el("strong", {}, card.text || "未入力")
      )
    )
  );
}

function getWritingDraftValue(card) {
  if (card.text.trim().length > 0) return card.text;
  return hasOwn(appState.textDrafts, card.id) ? appState.textDrafts[card.id] : card.text;
}

function handleWritingDraftInput(event) {
  const input = event.currentTarget;
  if (!input.name) return;
  appState.textDrafts[input.name] = input.value;
}

function clearWritingDrafts(cardIds = null) {
  if (!cardIds) {
    appState.textDrafts = {};
    return;
  }
  for (const cardId of cardIds) {
    delete appState.textDrafts[cardId];
  }
}

function pruneWritingDrafts(room) {
  if (!room || room.phase !== "writing" || !room.currentRound || !appState.playerId) {
    clearWritingDrafts();
    return;
  }

  const activeDraftCardIds = new Set(
    room.currentRound.cards
      .filter((card) => card.playerId === appState.playerId && card.text.trim().length === 0)
      .map((card) => card.id)
  );
  for (const cardId of Object.keys(appState.textDrafts)) {
    if (!activeDraftCardIds.has(cardId)) delete appState.textDrafts[cardId];
  }
}

function renderSubmit() {
  const room = appState.room;
  const round = room.currentRound;
  if (isPattern2Round(room, round)) return renderPattern2Submit();

  return panel("場のカード", [
    themeHero(round.roundNumber, round.theme),
    renderSubmissionTrack(round),
    renderTableCards({ showRevealed: false }),
    renderOwnSubmitCards()
  ]);
}

function renderPattern2Submit() {
  const room = appState.room;
  const round = appState.room.currentRound;
  const canEdit = isHost();
  return panel("カードを並べ替える", [
    themeHero(round.roundNumber, round.theme),
    el("p", { class: "muted-text microcopy" }, "左から小さい順になるように並べ替えます。数字は判定まで公開されません。"),
    renderPattern2ArrangeBoard(round, canEdit),
    canEdit
      ? el(
          "div",
          { class: "action-row" },
          button("この並びで判定", confirmPattern2Order, "primary")
        )
      : el("p", { class: "muted-text" }, "ホストの判定待ち")
  ]);
}

function renderPattern2ArrangeBoard(round, canEdit) {
  const orderedCards = getPattern2OrderedCards(round);
  return el(
    "div",
    { class: "arrange-board" },
    ...orderedCards.map((card, index) => renderPattern2ArrangeCard(card, index, orderedCards.length, canEdit))
  );
}

function renderPattern2ArrangeCard(card, index, total, canEdit) {
  const player = getPlayer(card.playerId);
  const dragAttrs = canEdit
    ? {
        draggable: "true",
        ondragstart: (event) => handlePattern2DragStart(event, card.id),
        ondragover: handlePattern2DragOver,
        ondrop: (event) => handlePattern2Drop(event, card.id)
      }
    : {};

  return el(
    "article",
    { class: `arrange-card ${canEdit ? "editable" : ""}`, ...dragAttrs },
    el(
      "div",
      { class: "arrange-card-head" },
      el("span", { class: "arrange-position" }, String(index + 1)),
      el("strong", { class: "card-number-chip hidden-number" }, "?")
    ),
    el("p", {}, card.text || "未入力"),
    el("small", {}, player ? player.name : "不明"),
    canEdit
      ? el(
          "div",
          { class: "arrange-actions" },
          button("←", () => movePattern2CardByOffset(card.id, -1), "ghost compact", { disabled: index === 0, ariaLabel: "左へ移動" }),
          button("→", () => movePattern2CardByOffset(card.id, 1), "ghost compact", { disabled: index >= total - 1, ariaLabel: "右へ移動" })
        )
      : null
  );
}

function renderSubmitReview() {
  const room = appState.room;
  const round = room.currentRound;
  const movesToVote = room.settings.culpritTokens && round.lifeLost > 0;
  const movesToFinal = room.life <= 0 || round.roundNumber >= room.settings.maxRounds;
  const nextLabel =
    movesToVote
      ? "うっかり投票へ"
      : movesToFinal
        ? "最終結果へ"
        : "次のお題へ";

  return panel("結果確認", [
    themeHero(round.roundNumber, round.theme),
    renderSubmissionTrack(round),
    renderTableCards({ showRevealed: false }),
    isHost()
      ? button(nextLabel, proceedAfterSubmitReview, "primary")
      : el("p", { class: "muted-text" }, "ホストの確認待ち")
  ]);
}

function renderTableCards({ showRevealed = true } = {}) {
  const room = appState.room;
  const round = room.currentRound;
  const cards = isPattern2Round(room, round) ? getPattern2OrderedCards(round) : round.cards;
  const activeCards = cards.filter((card) => !card.revealed);
  const revealedCards = cards.filter((card) => card.revealed);

  return el(
    "div",
    { class: "table-wrap" },
    activeCards.length
      ? [
          el("h3", {}, "未公開"),
          el(
            "div",
            { class: "table-cards" },
            ...activeCards.map((card) => renderHintCard(card, false))
          )
        ]
      : null,
    showRevealed && revealedCards.length
      ? el(
          "div",
          { class: "revealed-zone" },
          el("h3", {}, "公開済み"),
          el("div", { class: "table-cards" }, ...revealedCards.map((card) => renderHintCard(card, true)))
        )
      : null
  );
}

function renderSubmissionTrack(round) {
  const revealedCards = isPattern2Round(appState.room, round)
    ? getPattern2OrderedCards(round).filter((card) => card.revealed)
    : round.cards
        .filter((card) => card.revealed)
        .sort((a, b) => a.number - b.number);
  if (!revealedCards.length) return null;

  return el(
    "section",
    { class: "submission-track-wrap" },
    el("h3", {}, "提出結果"),
    el(
      "div",
      { class: "submission-track" },
      ...revealedCards.map((card) => renderSubmissionTrackCard(card))
    )
  );
}

function renderSubmissionTrackCard(card) {
  const player = getPlayer(card.playerId);
  const statusText = card.skipped ? "パスされたカード" : card.failed ? "飛ばして配置してしまったカード" : "成功";
  const className = [
    "submission-track-card",
    card.skipped ? "skipped" : card.failed ? "failed-submission" : "success"
  ].join(" ");

  return el(
    "article",
    { class: className, style: cardNumberStyle(card.number), "aria-label": `${card.number}: ${statusText}` },
    el("strong", { class: "card-number-chip graded" }, String(card.number)),
    el("span", {}, card.text || "未入力"),
    el("small", {}, player ? player.name : "不明")
  );
}

function renderHintCard(card, revealed) {
  const player = getPlayer(card.playerId);
  const own = card.playerId === appState.playerId;
  const status = card.skipped ? "飛ばし" : card.submitted ? "提出" : "未公開";
  const showNumber = revealed || own;
  const numberAttrs = showNumber
    ? { class: "card-number-chip graded", style: cardNumberStyle(card.number) }
    : { class: "card-number-chip hidden-number" };
  return el(
    "article",
    { class: `hint-card ${revealed ? "revealed" : ""} ${card.failed ? "failed" : ""} ${own ? "own" : ""}` },
    el(
      "div",
      { class: "hint-card-head" },
      el("span", {}, player ? player.name : "不明"),
      el("strong", numberAttrs, showNumber ? String(card.number) : "?")
    ),
    el("p", {}, card.text || "未入力"),
    el("div", { class: "hint-card-foot" }, pill(status, card.failed || card.skipped ? "danger" : revealed ? "ok" : "muted"))
  );
}

function renderOwnSubmitCards() {
  const cards = getOwnActiveRoundCards().filter((card) => !card.revealed);
  if (!cards.length) {
    return el("p", { class: "muted-text" }, "提出できる手札がありません");
  }
  return el(
    "div",
    { class: "own-submit" },
    el("h3", {}, "手札"),
    el(
      "div",
      { class: "submit-grid" },
      ...cards.map((card) =>
        el(
          "div",
          { class: "submit-card" },
          el("strong", { class: "card-number-chip graded", style: cardNumberStyle(card.number) }, String(card.number)),
          el("span", {}, card.text),
          button("提出", () => submitCard(card.id), "primary")
        )
      )
    )
  );
}

function renderVote() {
  const room = appState.room;
  const round = room.currentRound;
  const roundPlayers = getRoundPlayers(room, round);
  const roundPlayerIds = getRoundPlayerIds(room, round);
  const isParticipant = isRoundParticipant(room, round, appState.playerId);
  const votedCount = countRoundVotes(round, roundPlayerIds);
  const allVoted = votedCount >= roundPlayerIds.length;
  const ownVote = round.votes ? round.votes[appState.playerId] : undefined;

  return el(
    "div",
    { class: "content-grid" },
    panel("うっかり投票", [
      themeHero(round.roundNumber, round.theme),
      isParticipant
        ? el(
            "form",
            { class: "stack", onsubmit: handleVoteSubmit },
            el(
              "fieldset",
              {},
              el("legend", {}, "投票先"),
              radio("target", "none", "なし", ownVote === null || ownVote === undefined, false),
              ...roundPlayers.map((player) => radio("target", player.id, player.name, ownVote === player.id, false))
            ),
            button("投票", null, "primary", { type: "submit" })
          )
        : el("p", { class: "muted-text" }, "このラウンドは閲覧のみです")
    ]),
    panel("投票状況", [
      el("p", { class: "big-count" }, `${votedCount}/${roundPlayerIds.length}`),
      el("p", { class: "muted-text microcopy" }, allVoted ? "投票完了" : "投票待ち")
    ])
  );
}

function renderRoundEnd() {
  const latest = getLatestLog();
  return panel("うっかり投票結果", [
    renderVoteRanking(latest),
    isHost() ? button("次のラウンドへ", nextRound, "primary") : el("p", { class: "muted-text" }, "ホストの進行待ち")
  ]);
}

function renderGameOver() {
  const room = appState.room;
  const text = buildExportText(room);
  return panel("最終結果", [
    renderGameOutcome(room),
    renderClearHistory(room),
    renderFinalResults(room),
    el(
      "div",
      { class: "action-row" },
      button("結果をコピー", () => copyText(text), "primary"),
      isHost() ? button("同じ設定でもう一度", playAgainSameSettings, "secondary") : null,
      isHost() ? button("設定を変えてもう一度", resetToLobby, "secondary") : null
    )
  ]);
}

function renderGameOutcome(room) {
  const latestLog = room.logs[room.logs.length - 1];
  const isClear = room.endReason === "rounds";
  const roundNumber = latestLog ? latestLog.roundNumber : room.round || 1;
  return el(
    "section",
    { class: `game-outcome ${isClear ? "clear" : "failure"}` },
    el("span", { class: "game-outcome-kicker" }, isClear ? "完走" : "結果"),
    el("strong", { class: "game-outcome-title" }, isClear ? "CLEAR!" : `Round ${roundNumber} で失敗...`),
    el("p", {}, isClear ? "すべてのラウンドを乗り切りました" : "ここまでのカードを確認しましょう")
  );
}

function renderFinalResults(room) {
  if (!room.logs.length) {
    return el("p", { class: "muted-text" }, "表示できる結果がありません");
  }

  return el(
    "section",
    { class: "final-results" },
    ...room.logs.map((log) => renderFinalRound(log))
  );
}

function renderFinalRound(log) {
  const culpritPlayerId = log.voteResult && log.voteResult.playerId ? log.voteResult.playerId : null;
  return el(
    "article",
    { class: "final-round" },
    themeHero(log.roundNumber, log.theme),
    el(
      "div",
      { class: "final-card-grid" },
      ...getLogDisplayCards(log).map((card) => renderFinalCard(card, culpritPlayerId))
    )
  );
}

function renderFinalCard(card, culpritPlayerId) {
  const isCulprit = card.playerId === culpritPlayerId;
  const statusText = card.skipped ? "パスされたカード" : card.failed ? "飛ばして配置してしまったカード" : "成功";
  return el(
    "article",
    {
      class: `final-card ${card.skipped ? "skipped" : ""} ${card.failed ? "failed" : ""} ${isCulprit ? "culprit" : ""}`,
      style: cardNumberStyle(card.number),
      "aria-label": `${card.number}: ${statusText}`
    },
    el(
      "div",
      { class: "final-card-head" },
      el("strong", { class: "card-number-chip graded" }, String(card.number)),
      el(
        "div",
        { class: "final-card-meta" },
        el("span", {}, card.playerName),
        isCulprit ? pill("うっかりさん", "warn") : null
      )
    ),
    el("p", {}, card.text || "未入力")
  );
}

function renderClearHistory(room) {
  const history = normalizeClearHistory(room.clearHistory);
  const failureRounds = Object.keys(history.failures).map((round) => Number(round));
  const maxRound = Math.max(room.settings.maxRounds, ...failureRounds, 1);

  return el(
    "section",
    { class: "clear-history" },
    el("h3", {}, "クリア履歴"),
    el(
      "div",
      { class: "clear-history-grid" },
      ...Array.from({ length: maxRound }, (_, index) => {
        const round = index + 1;
        return renderClearHistoryItem(`Round${round}で失敗`, history.failures[String(round)] || 0);
      }),
      renderClearHistoryItem("クリア", history.clears)
    )
  );
}

function renderClearHistoryItem(labelText, count) {
  return el(
    "div",
    { class: "clear-history-item" },
    el("span", {}, labelText),
    el("strong", {}, String(count))
  );
}

function renderVoteRanking(log) {
  if (!log || !log.voteResult) {
    return el("p", { class: "muted-text" }, "このラウンドの投票はありません");
  }

  const ranking = getVoteRanking(log);
  return el(
    "div",
    { class: "vote-ranking" },
    themeHero(log.roundNumber, log.theme),
    el(
      "div",
      { class: "vote-ranking-list" },
      ...ranking.map((item, index) =>
        el(
          "div",
          { class: `vote-ranking-row ${item.id === "none" ? "none-vote" : ""}` },
          el("span", { class: "vote-rank" }, `${index + 1}`),
          el("strong", {}, item.name),
          el("span", { class: "vote-count" }, `${item.count}票`)
        )
      )
    )
  );
}

function renderFinalPlayers() {
  return el(
    "div",
    { class: "player-list compact" },
    ...appState.room.players.map((player) =>
      el(
        "div",
        { class: "player-row" },
        el("span", { class: "player-name" }, player.name),
        el("span", { class: "player-meta" }, `うっかり票 ${player.culpritTokens || 0}`)
      )
    )
  );
}

async function createRoom() {
  await runAction(async () => {
    const key = crypto.randomUUID();
    for (let attempt = 0; attempt < ROOM_ID_MAX_ATTEMPTS; attempt += 1) {
      const roomId = makeRoomId();
      const room = normalizeRoom({
        id: roomId,
        hostKey: key,
        phase: "lobby",
        settings: DEFAULT_SETTINGS,
        players: [],
        round: 0,
        life: DEFAULT_SETTINGS.initialLife,
        currentRound: null,
        logs: [],
        clearHistory: { failures: {}, clears: 0 },
        endReason: null,
        roomMessage: null,
        expiresAt: expirationDateFromNow(),
        createdAt: nowIso(),
        updatedAt: nowIso()
      });

      try {
        await appState.store.create(room);
        saveHostKey(roomId, key);
        setRoomUrl(roomId);
        appState.roomId = roomId;
        appState.playerId = null;
        appState.hostKey = key;
        return;
      } catch (error) {
        if (!(error instanceof RoomIdCollisionError)) throw error;
      }
    }

    throw new Error("ルームIDの生成に失敗しました。もう一度お試しください。");
  });
}

async function handleRoomJoin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const roomId = String(form.get("roomId") || "").trim().toUpperCase();
  if (!roomId) return;
  setRoomUrl(roomId);
  appState.roomId = roomId;
  restoreClientKeys(roomId);
  await appState.store.connect(roomId);
}

async function handleNameSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const name = String(form.get("name") || "").trim();
  if (!name) return setError("名前を入力してください。");

  await runAction(async () => {
    const playerId = crypto.randomUUID();
    await appState.store.update((room) => {
      assertUniquePlayerName(room, name);
      room.players.push({
        id: playerId,
        name,
        culpritTokens: 0,
        lastSeenAt: nowIso(),
        joinedAt: nowIso()
      });
      if (room.hostKey && appState.hostKey === room.hostKey && !room.hostPlayerId) {
        room.hostPlayerId = playerId;
      }
      assignHostIfNeeded(room);
      return room;
    });
    appState.playerId = playerId;
    appState.nameDraft = "";
    savePlayerId(appState.room.id, playerId);
    syncPresence(appState.room);
  });
}

function handleNameDraftInput(event) {
  appState.nameDraft = event.currentTarget.value;
}

function handleSettingsChange(event) {
  if (!isHost()) return;
  const settings = readSettingsFromForm(event.currentTarget);
  scheduleSettingsSave(settings);
}

function readSettingsFromForm(formElement) {
  const form = new FormData(formElement);
  const currentSettings = appState.room ? appState.room.settings : DEFAULT_SETTINGS;
  return {
    maxRounds: clampInt(form.get("maxRounds"), 1, 20, 3),
    initialLife: clampInt(form.get("initialLife"), 1, 30, 3),
    cardIncrement: clampInt(form.get("cardIncrement"), 1, 20, 1),
    cardLimit: clampInt(form.get("cardLimit"), 1, 100, 5),
    sortMode: form.get("sortMode") === "pattern2" ? "pattern2" : "pattern1",
    pattern1LifeRule: form.has("pattern1LifeRule")
      ? normalizePattern1LifeRule(form.get("pattern1LifeRule"))
      : currentSettings.pattern1LifeRule,
    pattern2LifeRule: form.has("pattern2LifeRule")
      ? normalizePattern2LifeRule(form.get("pattern2LifeRule"))
      : currentSettings.pattern2LifeRule,
    culpritTokens: form.get("culpritTokens") === "true",
    inputVisibility: form.get("inputVisibility") === "live" ? "live" : "afterWriting"
  };
}

function normalizePattern1LifeRule(value) {
  return value === "skipped" ? "skipped" : "flat";
}

function normalizePattern2LifeRule(value) {
  return value === "moved" ? "moved" : "skipped";
}

function readVisibleSettings() {
  const form = document.querySelector(".settings-grid");
  return form ? readSettingsFromForm(form) : null;
}

function scheduleSettingsSave(settings) {
  clearSettingsSaveTimer();
  appState.settingsSaveTimer = window.setTimeout(() => {
    appState.settingsSaveTimer = null;
    saveSettings(settings);
  }, 250);
}

function clearSettingsSaveTimer() {
  if (!appState.settingsSaveTimer) return;
  window.clearTimeout(appState.settingsSaveTimer);
  appState.settingsSaveTimer = null;
}

async function saveSettings(settings) {
  clearMessages();
  try {
    await appState.store.update((room) => {
      requireHost(room);
      room.settings = settings;
      room.life = settings.initialLife;
      return room;
    });
  } catch (error) {
    setError(error.message || "ルールを更新できませんでした。");
    console.error(error);
  }
}

function preventFormSubmit(event) {
  event.preventDefault();
}

async function startGame() {
  const latestSettings = readVisibleSettings();
  clearSettingsSaveTimer();
  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      if (room.players.length < 1) throw new Error("メンバーが必要です。");
      if (latestSettings) {
        room.settings = latestSettings;
      }
      room.phase = "theme";
      room.round = 0;
      room.life = room.settings.initialLife;
      room.currentRound = null;
      room.logs = [];
      room.endReason = null;
      room.roomMessage = null;
      room.players = room.players.map((player) => ({ ...player, culpritTokens: 0 }));
      return room;
    });
  });
}

async function handleThemeSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const theme = String(form.get("theme") || "").trim();
  if (!theme) return setError("お題を入力してください。");

  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      const nextRound = room.round + 1;
      const cardsPerPlayer = getCardsPerPlayer(room, nextRound);
      if (cardsPerPlayer < 1) throw new Error("カードを配れません。メンバー数と手札上限を確認してください。");
      const cards = dealCards(room.players, cardsPerPlayer, nextRound);
      room.currentRound = {
        roundNumber: nextRound,
        theme,
        sortMode: room.settings.sortMode,
        pattern1LifeRule: room.settings.pattern1LifeRule,
        pattern2LifeRule: room.settings.pattern2LifeRule,
        playerIds: room.players.map((player) => player.id),
        cards,
        arrangedCardIds: room.settings.sortMode === "pattern2" ? cards.map((card) => card.id) : [],
        submitLog: [],
        votes: {},
        voteResult: null,
        lifeBefore: room.life,
        lifeLost: 0,
        createdAt: nowIso()
      };
      room.phase = "writing";
      return room;
    });
  });
}

async function handleTextSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const submittedCardIds = Array.from(form.keys()).map((key) => String(key));

  await runAction(async () => {
    await appState.store.update((room) => {
      requirePhase(room, "writing");
      const round = room.currentRound;
      if (!isRoundParticipant(room, round, appState.playerId)) return room;
      round.cards = round.cards.map((card) => {
        if (card.playerId !== appState.playerId) return card;
        const text = String(form.get(card.id) || "").trim();
        return { ...card, text };
      });
      if (round.cards.every((card) => card.text.trim().length > 0)) {
        room.phase = "submit";
      }
      return room;
    });
    clearWritingDrafts(submittedCardIds);
  });
}

async function advanceToSubmit() {
  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      requirePhase(room, "writing");
      if (!room.currentRound.cards.every((card) => card.text.trim().length > 0)) {
        throw new Error("未入力のカードがあります。");
      }
      room.phase = "submit";
      return room;
    });
  });
}

async function submitCard(cardId) {
  await runAction(async () => {
    await appState.store.update((room) => {
      requirePhase(room, "submit");
      const round = room.currentRound;
      if (isPattern2Round(room, round)) throw new Error("このラウンドは全カード一括判定です。");
      const card = round.cards.find((item) => item.id === cardId);
      if (!card) throw new Error("カードが見つかりません。");
      if (card.playerId !== appState.playerId) throw new Error("自分のカードだけ提出できます。");
      if (card.revealed) throw new Error("公開済みのカードです。");

      const activeCards = round.cards.filter((item) => !item.revealed);
      const skippedCards = activeCards.filter((item) => item.id !== card.id && item.number < card.number);
      const success = skippedCards.length === 0;
      const lifeLoss = success ? 0 : (round.pattern1LifeRule || room.settings.pattern1LifeRule) === "skipped" ? skippedCards.length : 1;
      const skippedIds = new Set(skippedCards.map((item) => item.id));

      round.cards = round.cards.map((item) => {
        if (skippedIds.has(item.id)) {
          return { ...item, revealed: true, skipped: true, failed: true };
        }
        if (item.id === card.id) {
          return { ...item, revealed: true, submitted: true, failed: !success };
        }
        return item;
      });

      round.submitLog.push({
        cardId: card.id,
        playerId: card.playerId,
        playerName: getPlayerName(room, card.playerId),
        number: card.number,
        text: card.text,
        success,
        skippedCards: skippedCards.map((item) => ({
          cardId: item.id,
          playerId: item.playerId,
          playerName: getPlayerName(room, item.playerId),
          number: item.number,
          text: item.text
        })),
        lifeLoss,
        at: nowIso()
      });

      if (lifeLoss > 0) {
        round.lifeLost += lifeLoss;
        room.life -= lifeLoss;
      }

      const complete = round.cards.every((item) => item.revealed);
      if (complete) {
        room.phase = "submitReview";
      }

      return room;
    });
  });
}

function handlePattern2DragStart(event, cardId) {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", cardId);
}

function handlePattern2DragOver(event) {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function handlePattern2Drop(event, targetCardId) {
  event.preventDefault();
  if (!event.dataTransfer) return;
  const draggedCardId = event.dataTransfer.getData("text/plain");
  if (!draggedCardId || draggedCardId === targetCardId) return;
  movePattern2CardBefore(draggedCardId, targetCardId);
}

async function movePattern2CardBefore(cardId, targetCardId) {
  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      requirePhase(room, "submit");
      const round = room.currentRound;
      requirePattern2Round(room, round);
      round.arrangedCardIds = moveBefore(getPattern2CardIds(round), cardId, targetCardId);
      return room;
    });
  });
}

async function movePattern2CardByOffset(cardId, offset) {
  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      requirePhase(room, "submit");
      const round = room.currentRound;
      requirePattern2Round(room, round);
      const ids = getPattern2CardIds(round);
      const index = ids.indexOf(cardId);
      if (index < 0) throw new Error("カードが見つかりません。");
      const nextIndex = Math.max(0, Math.min(ids.length - 1, index + offset));
      if (nextIndex === index) return room;
      ids.splice(index, 1);
      ids.splice(nextIndex, 0, cardId);
      round.arrangedCardIds = ids;
      return room;
    });
  });
}

async function confirmPattern2Order() {
  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      requirePhase(room, "submit");
      const round = room.currentRound;
      requirePattern2Round(room, round);
      finalizePattern2Order(room);
      return room;
    });
  });
}

function finalizePattern2Order(room) {
  const round = room.currentRound;
  const orderedCards = getPattern2OrderedCards(round);
  const failedCardIds = getPattern2FailedCardIds(orderedCards);
  const hasFailure = failedCardIds.size > 0;
  const lifeLoss = hasFailure
    ? getPattern2LifeLoss(orderedCards.map((card) => card.number), round.pattern2LifeRule || room.settings.pattern2LifeRule)
    : 0;

  round.arrangedCardIds = orderedCards.map((card) => card.id);
  round.cards = round.cards.map((card) => ({
    ...card,
    revealed: true,
    submitted: true,
    failed: failedCardIds.has(card.id)
  }));
  round.submitLog.push({
    type: "pattern2",
    orderedCards: orderedCards.map((card) => ({
      cardId: card.id,
      playerId: card.playerId,
      playerName: getPlayerName(room, card.playerId),
      number: card.number,
      text: card.text,
      failed: failedCardIds.has(card.id)
    })),
    success: !hasFailure,
    lifeLoss,
    at: nowIso()
  });

  if (lifeLoss > 0) {
    round.lifeLost += lifeLoss;
    room.life -= lifeLoss;
  }

  room.phase = "submitReview";
}

async function proceedAfterSubmitReview() {
  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      requirePhase(room, "submitReview");
      const round = room.currentRound;
      if (!round.cards.every((card) => card.revealed)) {
        throw new Error("未公開のカードがあります。");
      }
      if (room.settings.culpritTokens && round.lifeLost > 0) {
        room.phase = "vote";
      } else {
        completeRound(room);
      }
      return room;
    });
  });
}

async function handleVoteSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const target = String(form.get("target") || "none");

  await runAction(async () => {
    await appState.store.update((room) => {
      requirePhase(room, "vote");
      const round = room.currentRound;
      const roundPlayerIds = getRoundPlayerIds(room, round);
      if (!isRoundParticipant(room, round, appState.playerId)) {
        throw new Error("このラウンドでは投票できません。");
      }
      const validTargets = new Set(roundPlayerIds);
      round.votes = round.votes || {};
      round.votes[appState.playerId] = target === "none" ? null : validTargets.has(target) ? target : null;
      if (countRoundVotes(round, roundPlayerIds) >= roundPlayerIds.length) {
        finalizeVote(room);
      }
      return room;
    });
  });
}

async function closeVote() {
  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      requirePhase(room, "vote");
      const round = room.currentRound;
      const roundPlayerIds = getRoundPlayerIds(room, round);
      if (countRoundVotes(round, roundPlayerIds) < roundPlayerIds.length) {
        throw new Error("未投票のメンバーがいます。");
      }
      finalizeVote(room);
      return room;
    });
  });
}

function finalizeVote(room) {
  const round = room.currentRound;
  const result = tallyVotes(room, round.votes || {}, getRoundPlayerIds(room, round));
  round.voteResult = result;
  if (result.playerId) {
    room.players = room.players.map((player) =>
      player.id === result.playerId ? { ...player, culpritTokens: (player.culpritTokens || 0) + 1 } : player
    );
  }
  completeRound(room);
}

async function nextRound() {
  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      requirePhase(room, "roundEnd");
      room.phase = "theme";
      room.currentRound = null;
      return room;
    });
  });
}

async function resetToLobby() {
  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      resetGameState(room, "lobby");
      return room;
    });
  });
}

async function playAgainSameSettings() {
  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      resetGameState(room, "theme");
      return room;
    });
  });
}

function resetGameState(room, phase) {
  room.phase = phase;
  room.round = 0;
  room.life = room.settings.initialLife;
  room.currentRound = null;
  room.logs = [];
  room.endReason = null;
  room.roomMessage = null;
  room.players = room.players.map((player) => ({ ...player, culpritTokens: 0 }));
}

function completeRound(room) {
  const round = room.currentRound;
  if (!round) return;

  const afterPenalty = room.life;
  let bonus = 0;
  if (room.life > 0) {
    bonus = 1;
    room.life += bonus;
  }

  const log = buildRoundLog(room, round, afterPenalty, bonus);
  room.logs.push(log);
  room.round = round.roundNumber;
  room.currentRound = null;

  if (afterPenalty <= 0) {
    recordClearHistory(room, "failure", round.roundNumber);
    room.phase = "gameOver";
    room.endReason = "life";
    return;
  }

  if (room.round >= room.settings.maxRounds) {
    recordClearHistory(room, "clear", round.roundNumber);
    room.phase = "gameOver";
    room.endReason = "rounds";
    return;
  }

  room.phase = log.voteResult ? "roundEnd" : "theme";
}

function recordClearHistory(room, result, roundNumber) {
  room.clearHistory = normalizeClearHistory(room.clearHistory);
  if (result === "clear") {
    room.clearHistory.clears += 1;
    return;
  }
  const key = String(roundNumber);
  room.clearHistory.failures[key] = (room.clearHistory.failures[key] || 0) + 1;
}

function normalizeClearHistory(history) {
  const failures = {};
  const rawFailures = history && typeof history.failures === "object" ? history.failures : {};
  for (const [round, count] of Object.entries(rawFailures)) {
    const normalizedCount = Number(count || 0);
    if (normalizedCount > 0) failures[String(round)] = normalizedCount;
  }
  return {
    failures,
    clears: Number(history && history.clears ? history.clears : 0)
  };
}

function buildRoundLog(room, round, afterPenalty, bonus) {
  return {
    roundNumber: round.roundNumber,
    theme: round.theme,
    sortMode: round.sortMode || room.settings.sortMode,
    arrangedCardIds: Array.isArray(round.arrangedCardIds) ? [...round.arrangedCardIds] : [],
    playerIds: getRoundPlayerIds(room, round),
    cards: round.cards.map((card) => ({
      id: card.id,
      playerId: card.playerId,
      playerName: getPlayerName(room, card.playerId),
      number: card.number,
      text: card.text,
      submitted: Boolean(card.submitted),
      skipped: Boolean(card.skipped),
      failed: Boolean(card.failed)
    })),
    submitLog: round.submitLog,
    judgment: round.lifeLost > 0 ? "failure" : "success",
    life: {
      before: round.lifeBefore,
      lost: round.lifeLost,
      afterPenalty,
      bonus,
      after: afterPenalty + bonus
    },
    voteResult: round.voteResult,
    votes: Object.entries(round.votes || {})
      .filter(([playerId]) => getRoundPlayerIds(room, round).includes(playerId))
      .map(([playerId, targetId]) => ({
        playerId,
        playerName: getPlayerName(room, playerId),
        targetId,
        targetName: targetId ? getPlayerName(room, targetId) : "なし"
      })),
    completedAt: nowIso()
  };
}

function tallyVotes(room, votes, playerIds = null) {
  const eligiblePlayerIds = playerIds || room.players.map((player) => player.id);
  const eligibleVoters = new Set(eligiblePlayerIds);
  const counts = { none: 0 };
  for (const playerId of eligiblePlayerIds) counts[playerId] = 0;

  for (const [voterId, targetId] of Object.entries(votes)) {
    if (!eligibleVoters.has(voterId)) continue;
    if (targetId && counts[targetId] !== undefined) counts[targetId] += 1;
    else counts.none += 1;
  }

  const max = Math.max(...Object.values(counts));
  const winners = Object.entries(counts).filter(([, count]) => count === max);
  if (winners.length !== 1 || winners[0][0] === "none") {
    return { playerId: null, playerName: "なし", counts };
  }

  const playerId = winners[0][0];
  return { playerId, playerName: getPlayerName(room, playerId), counts };
}

function buildExportText(room) {
  const lines = [];

  for (const [index, log] of room.logs.entries()) {
    if (index > 0) lines.push("");
    lines.push(`--- お題：${log.theme} ---`);
    const culpritPlayerId = log.voteResult && log.voteResult.playerId ? log.voteResult.playerId : null;
    for (const card of getLogDisplayCards(log)) {
      const culpritMark = card.playerId === culpritPlayerId ? " ★うっかりさん" : "";
      lines.push(`${card.playerName}：${card.text} (${card.number})${culpritMark}`);
    }
  }

  return lines.join("\n");
}

function getLogDisplayCards(log) {
  if (log.sortMode === "pattern2" && Array.isArray(log.arrangedCardIds) && log.arrangedCardIds.length) {
    const cardsById = new Map((log.cards || []).map((card) => [card.id, card]));
    const orderedCards = log.arrangedCardIds
      .map((cardId) => cardsById.get(cardId))
      .filter(Boolean);
    for (const card of log.cards || []) {
      if (!orderedCards.some((item) => item.id === card.id)) orderedCards.push(card);
    }
    return orderedCards;
  }
  return [...(log.cards || [])].sort((a, b) => a.number - b.number);
}

function normalizeRoom(room) {
  const settings = { ...DEFAULT_SETTINGS, ...(room.settings || {}) };
  settings.pattern1LifeRule = normalizePattern1LifeRule(settings.pattern1LifeRule);
  settings.pattern2LifeRule = normalizePattern2LifeRule(settings.pattern2LifeRule);
  const players = Array.isArray(room.players)
    ? room.players.map((player) => ({
        ...player,
        lastSeenAt: player.lastSeenAt || player.joinedAt || null
      }))
    : [];
  const hostPlayerId =
    room.hostPlayerId && players.some((player) => player.id === room.hostPlayerId)
      ? room.hostPlayerId
      : players.length
        ? players[0].id
        : null;
  return {
    id: room.id,
    hostKey: room.hostKey || "",
    hostPlayerId,
    phase: room.phase || "lobby",
    settings,
    players,
    round: Number(room.round || 0),
    life: Number(room.life ?? settings.initialLife),
    currentRound: room.currentRound || null,
    logs: Array.isArray(room.logs) ? room.logs : [],
    clearHistory: normalizeClearHistory(room.clearHistory),
    endReason: room.endReason || null,
    roomMessage: room.roomMessage || null,
    expiresAt: normalizeDateTime(room.expiresAt, expirationDateFromNow()),
    createdAt: room.createdAt || nowIso(),
    updatedAt: room.updatedAt || nowIso()
  };
}

function dealCards(players, count, roundNumber) {
  const numbers = shuffle(Array.from({ length: 100 }, (_, index) => index + 1));
  let cursor = 0;
  const cards = [];
  for (const player of players) {
    const playerNumbers = numbers.slice(cursor, cursor + count).sort((a, b) => a - b);
    cursor += count;
    for (let index = 0; index < playerNumbers.length; index += 1) {
      cards.push({
        id: `r${roundNumber}-${player.id}-${index}-${playerNumbers[index]}`,
        playerId: player.id,
        number: playerNumbers[index],
        text: "",
        revealed: false,
        submitted: false,
        skipped: false,
        failed: false
      });
    }
  }
  return cards;
}

function getCardsPerPlayer(room, roundNumber) {
  const raw = 1 + (roundNumber - 1) * room.settings.cardIncrement;
  const playerLimit = Math.floor(100 / Math.max(room.players.length, 1));
  return Math.min(raw, room.settings.cardLimit, playerLimit);
}

function shuffle(items) {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    const swapIndex = Math.floor(random * (index + 1));
    [list[index], list[swapIndex]] = [list[swapIndex], list[index]];
  }
  return list;
}

function getCurrentPlayer() {
  if (!appState.room || !appState.playerId) return null;
  return appState.room.players.find((player) => player.id === appState.playerId) || null;
}

function getPlayer(playerId) {
  if (!appState.room) return null;
  return appState.room.players.find((player) => player.id === playerId) || null;
}

function getPlayerName(room, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  return player ? player.name : "不明";
}

function getRoundPlayerIds(room, round) {
  if (!round) return [];
  const ids = Array.isArray(round.playerIds) && round.playerIds.length
    ? round.playerIds
    : round.cards.map((card) => card.playerId);
  return [...new Set(ids)].filter((playerId) => room.players.some((player) => player.id === playerId));
}

function getRoundPlayers(room, round) {
  const playersById = new Map(room.players.map((player) => [player.id, player]));
  return getRoundPlayerIds(room, round)
    .map((playerId) => playersById.get(playerId))
    .filter(Boolean);
}

function isRoundParticipant(room, round, playerId) {
  if (!playerId) return false;
  return getRoundPlayerIds(room, round).includes(playerId);
}

function countRoundVotes(round, playerIds) {
  const eligibleVoters = new Set(playerIds);
  return Object.keys(round.votes || {}).filter((playerId) => eligibleVoters.has(playerId)).length;
}

function getRoundSortMode(room, round) {
  return (round && round.sortMode) || room.settings.sortMode;
}

function isPattern2Round(room, round) {
  return getRoundSortMode(room, round) === "pattern2";
}

function requirePattern2Round(room, round) {
  if (!isPattern2Round(room, round)) throw new Error("全カード一括のラウンドではありません。");
}

function getPattern2CardIds(round) {
  const validIds = new Set(round.cards.map((card) => card.id));
  const arrangedIds = Array.isArray(round.arrangedCardIds) ? round.arrangedCardIds : [];
  const ids = [];
  for (const cardId of arrangedIds) {
    if (validIds.has(cardId) && !ids.includes(cardId)) ids.push(cardId);
  }
  for (const card of round.cards) {
    if (!ids.includes(card.id)) ids.push(card.id);
  }
  return ids;
}

function getPattern2OrderedCards(round) {
  const cardsById = new Map(round.cards.map((card) => [card.id, card]));
  return getPattern2CardIds(round)
    .map((cardId) => cardsById.get(cardId))
    .filter(Boolean);
}

function moveBefore(ids, cardId, targetCardId) {
  const nextIds = ids.filter((id) => id !== cardId);
  const targetIndex = nextIds.indexOf(targetCardId);
  if (targetIndex < 0) return ids;
  nextIds.splice(targetIndex, 0, cardId);
  return nextIds;
}

function getPattern2FailedCardIds(orderedCards) {
  const failedIds = new Set();
  let maxNumber = -Infinity;
  for (const card of orderedCards) {
    if (card.number < maxNumber) {
      failedIds.add(card.id);
    } else {
      maxNumber = card.number;
    }
  }
  return failedIds;
}

function getPattern2LifeLoss(numbers, rule) {
  if (!hasInversion(numbers)) return 0;
  if (rule === "moved") return numbers.length - longestIncreasingSubsequenceLength(numbers);
  return countPattern2SkippedCards(numbers);
}

function countPattern2SkippedCards(numbers) {
  let skipped = 0;
  let maxNumber = -Infinity;
  for (const number of numbers) {
    if (number < maxNumber) {
      skipped += 1;
    } else {
      maxNumber = number;
    }
  }
  return skipped;
}

function hasInversion(numbers) {
  let maxNumber = -Infinity;
  for (const number of numbers) {
    if (number < maxNumber) return true;
    maxNumber = number;
  }
  return false;
}

function longestIncreasingSubsequenceLength(numbers) {
  const tails = [];
  for (const number of numbers) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tails[middle] < number) low = middle + 1;
      else high = middle;
    }
    tails[low] = number;
  }
  return tails.length;
}

function getOwnActiveRoundCards() {
  const round = appState.room.currentRound;
  if (!round) return [];
  return round.cards.filter((card) => card.playerId === appState.playerId);
}

function getLatestLog() {
  return appState.room.logs[appState.room.logs.length - 1];
}

function getVoteRanking(log) {
  const counts = log.voteResult.counts || {};
  const playersById = new Map();
  for (const card of log.cards || []) {
    if (!playersById.has(card.playerId)) playersById.set(card.playerId, card.playerName || "不明");
  }
  const ranking = [...playersById.entries()].map(([playerId, playerName]) => ({
    id: playerId,
    name: playerName,
    count: counts[playerId] || 0
  }));
  if (counts.none > 0) {
    ranking.push({ id: "none", name: "なし", count: counts.none });
  }
  return ranking.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ja"));
}

function cardNumberStyle(number) {
  const ratio = Math.max(0, Math.min(1, (Number(number) - 1) / 99));
  const skySaturation = 34 + ratio * 48;
  const mintSaturation = 34 + ratio * 40;
  const skyLightness = 99 - ratio * 52;
  const mintLightness = 98 - ratio * 58;
  const ringLightness = 91 - ratio * 54;
  const color = ratio > 0.66 ? "#ffffff" : "#2c6775";
  return [
    `--number-bg: linear-gradient(145deg, hsl(190 ${skySaturation}% ${skyLightness}%), hsl(96 ${mintSaturation}% ${mintLightness}%))`,
    `--number-fg: ${color}`,
    `--number-ring: hsl(178 48% ${ringLightness}%)`
  ].join("; ");
}

function isHost() {
  return Boolean(appState.room && isCurrentUserHostFor(appState.room));
}

function isPlayerHost(room, playerId) {
  return room.hostPlayerId
    ? room.hostPlayerId === playerId
    : isHost() && appState.playerId === playerId;
}

function requireHost(room) {
  if (!isCurrentUserHostFor(room)) throw new Error("ホストだけ操作できます。");
}

function isCurrentUserHostFor(room) {
  if (!room) return false;
  if (room.hostPlayerId) return room.hostPlayerId === appState.playerId;
  return Boolean(appState.hostKey && room.hostKey === appState.hostKey);
}

function canRemovePlayer(playerId) {
  return isHost() && playerId !== appState.playerId;
}

function assignHostIfNeeded(room) {
  if (!room.players.length) {
    room.hostPlayerId = null;
    return;
  }
  if (!room.hostPlayerId || !room.players.some((player) => player.id === room.hostPlayerId)) {
    room.hostPlayerId = room.players[0].id;
  }
}

function isGameInProgress(room) {
  return !["lobby", "gameOver"].includes(room.phase);
}

function abortGameToLobby(room, message) {
  room.phase = "lobby";
  room.round = 0;
  room.life = room.settings.initialLife;
  room.currentRound = null;
  room.logs = [];
  room.endReason = null;
  room.roomMessage = message;
  room.players = room.players.map((player) => ({ ...player, culpritTokens: 0 }));
}

function removePlayerFromRoom(room, playerId, { self = false } = {}) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player) return;

  room.players = room.players.filter((item) => item.id !== playerId);
  if (room.currentRound && room.currentRound.votes) {
    delete room.currentRound.votes[playerId];
  }
  assignHostIfNeeded(room);

  if (isGameInProgress(room)) {
    const action = self ? "退出した" : "削除された";
    abortGameToLobby(room, `${player.name}が${action}ため、進行中のゲームを破棄しました。`);
  }
}

function syncPresence(room) {
  const currentPlayerActive = Boolean(
    room &&
      appState.playerId &&
      room.players.some((player) => player.id === appState.playerId)
  );

  if (!currentPlayerActive) {
    stopPresenceHeartbeat();
    return;
  }

  if (!appState.presenceTimer) {
    appState.presenceTimer = window.setInterval(sendPresenceHeartbeat, PRESENCE_HEARTBEAT_MS);
  }

  if (Date.now() - appState.lastPresenceUpdateAt >= PRESENCE_HEARTBEAT_MS) {
    sendPresenceHeartbeat();
  }
  maybeAutoClaimStaleHost(room);
}

function stopPresenceHeartbeat() {
  if (appState.presenceTimer) {
    window.clearInterval(appState.presenceTimer);
    appState.presenceTimer = null;
  }
  appState.lastPresenceUpdateAt = 0;
  appState.autoHostClaimInFlight = false;
}

async function sendPresenceHeartbeat() {
  if (appState.loading || !appState.store || !appState.room || !appState.playerId) return;
  if (Date.now() - appState.lastPresenceUpdateAt < PRESENCE_HEARTBEAT_MS) return;

  appState.lastPresenceUpdateAt = Date.now();
  try {
    await appState.store.update((room) => {
      if (!markPlayerSeen(room, appState.playerId)) return null;
      return room;
    });
  } catch (error) {
    console.error(error);
  }
}

function markPlayerSeen(room, playerId, seenAt = nowIso()) {
  let changed = false;
  room.players = room.players.map((player) => {
    if (player.id !== playerId) return player;
    changed = true;
    return { ...player, lastSeenAt: seenAt };
  });
  return changed;
}

function maybeAutoClaimStaleHost(room) {
  if (appState.loading || appState.autoHostClaimInFlight || !appState.playerId || isHost()) return;

  const candidateId = getAutoHostCandidateId(room, Date.now(), appState.playerId);
  if (candidateId !== appState.playerId) return;

  appState.autoHostClaimInFlight = true;
  appState.store.update((latestRoom) => {
    const latestCandidateId = getAutoHostCandidateId(latestRoom, Date.now(), appState.playerId);
    if (latestCandidateId !== appState.playerId) return null;
    markPlayerSeen(latestRoom, appState.playerId);
    latestRoom.hostPlayerId = appState.playerId;
    return latestRoom;
  }).catch((error) => {
    console.error(error);
  }).finally(() => {
    appState.autoHostClaimInFlight = false;
  });
}

function getAutoHostCandidateId(room, nowMs = Date.now(), fallbackPlayerId = null) {
  if (!room || !room.players.length || !isHostStale(room, nowMs)) return null;
  const activePlayers = room.players.filter((player) =>
    player.id !== room.hostPlayerId && isPlayerRecentlySeen(player, nowMs)
  );
  if (activePlayers.length) return activePlayers[0].id;
  return fallbackPlayerId && room.players.some((player) => player.id === fallbackPlayerId)
    ? fallbackPlayerId
    : null;
}

function isHostStale(room, nowMs = Date.now()) {
  if (!room.hostPlayerId) return true;
  const host = room.players.find((player) => player.id === room.hostPlayerId);
  if (!host) return true;
  return !isPlayerRecentlySeen(host, nowMs);
}

function isPlayerRecentlySeen(player, nowMs = Date.now()) {
  const seenAtMs = dateTimeToMillis(player.lastSeenAt);
  return seenAtMs !== null && nowMs - seenAtMs <= HOST_STALE_MS;
}

function requirePhase(room, phase) {
  if (room.phase !== phase) throw new Error(`現在は${PHASE_LABELS[room.phase] || room.phase}フェーズです。`);
}

function assertUniquePlayerName(room, name) {
  const normalized = normalizeName(name);
  const exists = room.players.some((player) => normalizeName(player.name) === normalized);
  if (exists) throw new Error("同じ名前のメンバーがいます。");
}

function normalizeName(name) {
  return name.trim().toLocaleLowerCase("ja-JP");
}

function sortModeLabel(value) {
  return value === "pattern2" ? "全カード一括" : "1枚ずつ";
}

function lifeRuleLabel(settings) {
  return settings.sortMode === "pattern2"
    ? pattern2LifeRuleLabel(settings.pattern2LifeRule)
    : pattern1LifeRuleLabel(settings.pattern1LifeRule);
}

function pattern1LifeRuleLabel(value) {
  return value === "skipped" ? "飛ばした枚数分" : "一律 -1";
}

function pattern2LifeRuleLabel(value) {
  return value === "moved" ? "最小移動枚数分" : "飛ばされたカード枚数分";
}

function inputVisibilityLabel(value) {
  return value === "live" ? "入力中も表示" : "全員入力後";
}

async function runAction(action) {
  if (appState.loading) return;
  appState.loading = true;
  clearMessages();
  render();
  try {
    await action();
  } catch (error) {
    setError(error.message || "処理に失敗しました。");
    console.error(error);
  } finally {
    appState.loading = false;
    render();
  }
}

function setError(message) {
  appState.error = message;
  appState.notice = "";
  render();
}

function setNotice(message) {
  appState.notice = message;
  appState.error = "";
  render();
}

function clearMessages() {
  appState.notice = "";
  appState.error = "";
}

function getRoomIdFromUrl() {
  return new URLSearchParams(window.location.search).get("room");
}

function setRoomUrl(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  window.history.replaceState({}, "", url);
}

function leaveRoomUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  window.history.replaceState({}, "", url);
  appState.roomId = null;
  appState.playerId = null;
  appState.hostKey = null;
  appState.room = null;
  appState.missingRoom = false;
  appState.nameDraft = "";
  clearWritingDrafts();
  stopPresenceHeartbeat();
  appState.store.disconnect();
  render();
}

async function leaveCurrentRoom() {
  if (appState.loading) return;
  const roomId = appState.roomId || (appState.room && appState.room.id);
  const playerId = appState.playerId;
  const wasHost = appState.room ? isCurrentUserHostFor(appState.room) : false;

  if (!appState.room || !playerId) {
    if (roomId) {
      clearPlayerId(roomId);
      clearHostKey(roomId);
    }
    leaveRoomUrl();
    return;
  }

  appState.loading = true;
  clearMessages();
  render();
  try {
    await appState.store.update((room) => {
      removePlayerFromRoom(room, playerId, { self: true });
      return room;
    });
    clearPlayerId(roomId);
    if (wasHost) clearHostKey(roomId);
    leaveRoomUrl();
  } catch (error) {
    setError(error.message || "退出できませんでした。");
    console.error(error);
  } finally {
    appState.loading = false;
    render();
  }
}

async function removePlayer(playerId) {
  if (playerId === appState.playerId) {
    await leaveCurrentRoom();
    return;
  }

  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      removePlayerFromRoom(room, playerId);
      return room;
    });
  });
}

async function claimHost() {
  await runAction(async () => {
    await appState.store.update((room) => {
      const playerExists = appState.playerId && room.players.some((player) => player.id === appState.playerId);
      if (!playerExists) throw new Error("参加者だけがホストを引き継げます。");
      markPlayerSeen(room, appState.playerId);
      room.hostPlayerId = appState.playerId;
      return room;
    });
  });
}

function getShareUrl(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    setError("コピーできませんでした。");
  }
}

function makeRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function nowIso() {
  return new Date().toISOString();
}

function expirationDateFromNow() {
  return new Date(Date.now() + ROOM_TTL_MS);
}

function normalizeDateTime(value, fallback) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value && typeof value.toDate === "function") {
    const date = value.toDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return fallback;
}

function dateTimeToMillis(value) {
  const date = normalizeDateTime(value, null);
  return date ? date.getTime() : null;
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(String(value), 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function localRoomKey(roomId) {
  return `ito.room.${roomId}`;
}

function playerKey(roomId) {
  return `ito.player.${roomId}`;
}

function hostKey(roomId) {
  return `ito.host.${roomId}`;
}

function clientStorage() {
  return appState.syncMode === "local" ? sessionStorage : localStorage;
}

function restoreClientKeys(roomId) {
  if (!roomId) {
    appState.playerId = null;
    appState.hostKey = null;
    return;
  }
  const storage = clientStorage();
  appState.playerId = storage.getItem(playerKey(roomId));
  appState.hostKey = storage.getItem(hostKey(roomId));
}

function savePlayerId(roomId, playerId) {
  clientStorage().setItem(playerKey(roomId), playerId);
}

function saveHostKey(roomId, key) {
  clientStorage().setItem(hostKey(roomId), key);
}

function clearPlayerId(roomId) {
  clientStorage().removeItem(playerKey(roomId));
}

function clearHostKey(roomId) {
  clientStorage().removeItem(hostKey(roomId));
}

function readLocalRoom(roomId) {
  const raw = localStorage.getItem(localRoomKey(roomId));
  if (!raw) return null;
  try {
    return normalizeRoom(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeLocalRoom(room) {
  localStorage.setItem(localRoomKey(room.id), JSON.stringify(normalizeRoom(room)));
}

function panel(title, children) {
  return el(
    "section",
    { class: "panel" },
    el("div", { class: "panel-head" }, el("h2", {}, title)),
    el("div", { class: "panel-body" }, ...children.filter(Boolean))
  );
}

function metric(labelText, value) {
  return el(
    "div",
    { class: "metric" },
    el("span", {}, labelText),
    el("strong", {}, value)
  );
}

function label(text, control) {
  return el("label", { class: "field" }, el("span", {}, text), control);
}

function radio(name, value, text, checked, disabled) {
  return el(
    "label",
    { class: "radio-row" },
    el("input", { type: "radio", name, value, checked, disabled }),
    el("span", {}, text)
  );
}

function option(value, text, selected) {
  return el("option", { value, selected }, text);
}

function button(text, onClick, tone = "secondary", attrs = {}) {
  return el(
    "button",
    {
      type: attrs.type || "button",
      class: `button ${tone}`,
      disabled: attrs.disabled || appState.loading,
      title: attrs.title || null,
      "aria-label": attrs.ariaLabel || null,
      onclick: onClick || null
    },
    text
  );
}

function pill(text, tone = "muted") {
  return el("span", { class: `pill ${tone}` }, text);
}

function el(tag, attrs = {}, ...children) {
  const isSvg = tag === "svg" || tag === "path";
  const node = isSvg
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class" || key === "className") {
      if (isSvg) node.setAttribute("class", value);
      else node.className = value;
    } else if (key === "for") {
      node.htmlFor = value;
    } else if (key === "readonly") {
      node.readOnly = Boolean(value);
    } else if (key === "checked") {
      node.checked = Boolean(value);
    } else if (key === "selected") {
      node.selected = Boolean(value);
    } else if (key === "disabled") {
      node.disabled = Boolean(value);
    } else if (key === "value") {
      node.value = value;
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, value);
    }
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

boot();
