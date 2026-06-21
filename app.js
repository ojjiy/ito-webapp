const FIREBASE_APP_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
const FIREBASE_STORE_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PHASE_LABELS = {
  lobby: "ロビー",
  theme: "テーマ",
  writing: "入力",
  submit: "提出",
  submitReview: "確認",
  vote: "投票",
  roundEnd: "ラウンド終了",
  gameOver: "ゲーム終了"
};

const DEFAULT_SETTINGS = {
  maxRounds: 3,
  initialLife: 3,
  cardIncrement: 1,
  cardLimit: 5,
  sortMode: "pattern1",
  pattern1LifeRule: "flat",
  pattern2LifeRule: "flat",
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
  notice: "",
  error: ""
};

const root = document.querySelector("#app");

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

    try {
      const [{ initializeApp }, firestore] = await Promise.all([
        import(FIREBASE_APP_URL),
        import(FIREBASE_STORE_URL)
      ]);
      const firebaseApp = initializeApp(config);
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
    this.roomId = normalized.id;

    if (this.mode === "firebase") {
      const ref = this.fs.doc(this.db, "rooms", normalized.id);
      await this.fs.setDoc(ref, normalized);
    } else {
      writeLocalRoom(normalized);
    }

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
          this.onError("ルーム状態を取得できませんでした。");
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
        transaction.set(ref, normalizeRoom(next));
      });
      return;
    }

    const current = readLocalRoom(this.roomId);
    if (!current) throw new Error("ルームが見つかりません。");
    const next = mutator(deepCopy(current));
    if (!next) return;
    next.updatedAt = nowIso();
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
      render();
    },
    onMissing: (missing) => {
      appState.missingRoom = missing;
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
  root.replaceChildren(
    appShell(
      appState.room ? renderRoom() : renderEntry()
    )
  );
}

function appShell(content) {
  const room = appState.room;
  const phase = room ? PHASE_LABELS[room.phase] : "未接続";
  const roomText = room ? `ルーム ${room.id}` : "ルームなし";
  const localShareWarning =
    appState.syncMode === "local"
      ? "Localモードではルームはこのブラウザ内だけに保存されます。同じ通常ブラウザの複数タブでは別ユーザとして確認できます。別ブラウザやプライベートブラウザから参加するにはFirebase設定が必要です。"
      : "";

  return el(
    "div",
    { class: "app-frame" },
    el(
      "header",
      { class: "topbar" },
      el("div", { class: "brand" }, el("span", { class: "brand-mark" }, "i"), el("span", {}, "ito helper")),
      el(
        "div",
        { class: "topbar-meta" },
        pill(appState.syncMode === "firebase" ? "Firebase" : "Local", appState.syncMode === "firebase" ? "ok" : "warn"),
        pill(roomText, "muted"),
        pill(phase, "info")
      )
    ),
    appState.error ? el("div", { class: "banner error" }, appState.error) : null,
    appState.notice ? el("div", { class: "banner notice" }, appState.notice) : null,
    localShareWarning ? el("div", { class: "banner warning" }, localShareWarning) : null,
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
          ? el("p", { class: "muted-text" }, "Localモードでは、他のブラウザで作成したルームは参照できません。")
          : null,
        button("トップへ戻る", () => leaveRoomUrl(), "secondary")
      ])
    );
  }

  return el(
    "main",
    { class: "layout split" },
    panel("ルーム作成", [
      el("p", { class: "muted-text" }, "ホスト用の短命ルームを作成します。"),
      button("ルームを作成", createRoom, "primary")
    ]),
    panel("ルーム参加", [
      el(
        "form",
        { class: "stack", onsubmit: handleRoomJoin },
        label("ルームID", el("input", { name: "roomId", maxlength: "12", autocomplete: "off", required: true })),
        button("参加", null, "primary", { type: "submit" })
      )
    ])
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
  const showSidePanel = room.phase !== "lobby" && room.phase !== "gameOver";

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
    panel("名前登録", [
      el("p", { class: "muted-text" }, `ルーム ${room.id}`),
      el(
        "form",
        { class: "stack", onsubmit: handleNameSubmit },
        label("表示名", el("input", { name: "name", maxlength: "24", autocomplete: "name", required: true })),
        button("登録", null, "primary", { type: "submit" })
      )
    ])
  );
}

function renderRoomSummary() {
  const room = appState.room;
  const player = getCurrentPlayer();
  const host = isHost();
  const shareUrl = getShareUrl(room.id);
  const displayedRound = room.currentRound ? room.currentRound.roundNumber : room.round;

  return el(
    "section",
    { class: "summary-band" },
    el(
      "div",
      { class: "summary-grid" },
      metric("ライフ", String(room.life)),
      metric("ラウンド", `${displayedRound}/${room.settings.maxRounds}`),
      metric("参加者", `${room.players.length}人`),
      metric("あなた", player ? player.name : "-")
    ),
    el(
      "div",
      { class: "room-actions" },
      host ? pill("ホスト", "ok") : pill("参加者", "muted"),
      button("URLコピー", () => copyText(shareUrl), "secondary"),
      button("退出", leaveRoomUrl, "ghost")
    )
  );
}

function renderSidePanel() {
  const room = appState.room;
  const player = getCurrentPlayer();
  const settings = room.settings;

  return el(
    "aside",
    { class: "side-panel" },
    el(
      "section",
      { class: "side-section" },
      el("h2", {}, "あなた"),
      el("p", { class: "side-value" }, player ? player.name : "-"),
      el("div", { class: "side-pills" }, isHost() ? pill("ホスト", "ok") : pill("参加者", "muted"))
    ),
    el(
      "section",
      { class: "side-section" },
      el("h2", {}, "参加者"),
      el(
        "div",
        { class: "side-player-list" },
        ...room.players.map((item) =>
          el(
            "div",
            { class: "side-player" },
            el("span", {}, item.name),
            el("small", {}, `戦犯 ${item.culpritTokens || 0}`)
          )
        )
      )
    ),
    el(
      "section",
      { class: "side-section" },
      el("h2", {}, "設定"),
      renderRuleList([
        ["ラウンド", `${settings.maxRounds}`],
        ["初期ライフ", `${settings.initialLife}`],
        ["カード増加", `${settings.cardIncrement}`],
        ["1人上限", `${settings.cardLimit}`],
        ["並べ替え", sortModeLabel(settings.sortMode)],
        ["失敗時", pattern1LifeRuleLabel(settings.pattern1LifeRule)],
        ["戦犯", settings.culpritTokens ? "ON" : "OFF"],
        ["入力公開", inputVisibilityLabel(settings.inputVisibility)]
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

function renderLobby() {
  return el(
    "div",
    { class: "content-grid" },
    panel("ゲーム設定", [renderSettingsForm()]),
    panel("参加者", [renderPlayerList(), renderLobbyActions()])
  );
}

function renderSettingsForm() {
  const settings = appState.room.settings;
  const disabled = !isHost();

  return el(
    "form",
    { class: "settings-grid", onchange: handleSettingsChange, onsubmit: preventFormSubmit },
    label("ラウンド上限", el("input", { type: "number", name: "maxRounds", min: "1", max: "20", value: settings.maxRounds, disabled, required: true })),
    label("初期ライフ", el("input", { type: "number", name: "initialLife", min: "1", max: "30", value: settings.initialLife, disabled, required: true })),
    label("カード増加枚数", el("input", { type: "number", name: "cardIncrement", min: "1", max: "20", value: settings.cardIncrement, disabled, required: true })),
    label("1人上限", el("input", { type: "number", name: "cardLimit", min: "1", max: "100", value: settings.cardLimit, disabled, required: true })),
    el(
      "fieldset",
      { class: "field-span" },
      el("legend", {}, "並べ替えルール"),
      radio("sortMode", "pattern1", "1枚ずつ提出", settings.sortMode === "pattern1", disabled),
      radio("sortMode", "pattern2", "全カード一括判定（予定）", false, true)
    ),
    el(
      "fieldset",
      { class: "field-span" },
      el("legend", {}, "失敗時のライフ減少"),
      radio("pattern1LifeRule", "flat", "飛ばした枚数によらず -1", settings.pattern1LifeRule === "flat", disabled),
      radio("pattern1LifeRule", "skipped", "飛ばしたカード枚数分だけ減少", settings.pattern1LifeRule === "skipped", disabled)
    ),
    el(
      "fieldset",
      { class: "field-span" },
      el("legend", {}, "入力内容の公開"),
      radio("inputVisibility", "afterWriting", "全員入力後に公開", settings.inputVisibility === "afterWriting", disabled),
      radio("inputVisibility", "live", "入力中から随時公開", settings.inputVisibility === "live", disabled)
    ),
    label(
      "戦犯トークン",
      el(
        "select",
        { name: "culpritTokens", disabled },
        option("true", "ON", settings.culpritTokens),
        option("false", "OFF", !settings.culpritTokens)
      )
    )
  );
}

function renderLobbyActions() {
  const canStart = isHost() && appState.room.players.length > 0;
  return el(
    "div",
    { class: "action-row" },
    isHost() ? button("ゲーム開始", startGame, "primary", { disabled: !canStart }) : el("p", { class: "muted-text" }, "ホストの開始待ち")
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
        el("span", { class: "player-meta" }, `戦犯 ${player.culpritTokens || 0}`)
      )
    )
  );
}

function renderTheme() {
  const nextRound = appState.room.round + 1;
  return panel(`ラウンド ${nextRound} テーマ`, [
    isHost()
      ? el(
          "form",
          { class: "stack", onsubmit: handleThemeSubmit },
          label("テーマ", el("input", { name: "theme", maxlength: "80", required: true, autofocus: true })),
          button("カード配布", null, "primary", { type: "submit" })
        )
      : el("p", { class: "muted-text" }, "ホストのテーマ入力待ち")
  ]);
}

function renderWriting() {
  const round = appState.room.currentRound;
  const ownCards = getOwnActiveRoundCards();
  const allReady = round.cards.every((card) => card.text.trim().length > 0);

  return el(
    "div",
    { class: "content-grid" },
    panel(`ラウンド ${round.roundNumber}: ${round.theme}`, [
      el(
        "form",
        { class: "card-input-list", onsubmit: handleTextSubmit },
        ...ownCards.map((card, index) =>
          el(
            "div",
            { class: "number-card own" },
            el("div", { class: "number-card-head" }, el("span", {}, `#${index + 1}`), el("strong", {}, String(card.number))),
            label("入力", el("input", { name: card.id, maxlength: "80", value: card.text, required: true }))
          )
        ),
        ownCards.length ? button("入力を保存", null, "primary", { type: "submit" }) : el("p", { class: "muted-text" }, "自分のカードがありません。")
      )
    ]),
    panel("入力状況", [
      renderInputProgress(),
      el("p", { class: "muted-text" }, allReady ? "提出フェーズへ移動します。" : "全員の入力がそろうと自動で提出フェーズへ進みます。")
    ])
  );
}

function renderInputProgress() {
  const round = appState.room.currentRound;
  return el(
    "div",
    { class: "player-list" },
    ...appState.room.players.map((player) => {
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
        pill(ready ? "入力済" : "未入力", ready ? "ok" : "warn")
      );
    })
  );
}

function renderVisibleInputTexts(cards) {
  if (appState.room.settings.inputVisibility !== "live") return null;
  return el(
    "div",
    { class: "input-preview-list" },
    ...cards.map((card, index) => el("small", {}, `${index + 1}. ${card.text || "未入力"}`))
  );
}

function renderSubmit() {
  const round = appState.room.currentRound;
  return panel(`ラウンド ${round.roundNumber}: ${round.theme}`, [
    renderTableCards(),
    renderOwnSubmitCards(),
    round.submitLog.length ? renderSubmitLog() : null
  ]);
}

function renderSubmitReview() {
  const room = appState.room;
  const round = room.currentRound;
  const nextLabel =
    room.settings.culpritTokens && round.lifeLost > 0
      ? "戦犯投票へ進む"
      : "ラウンド結果へ進む";

  return panel(`ラウンド ${round.roundNumber}: 提出結果`, [
    renderTableCards(),
    round.submitLog.length ? renderSubmitLog() : null,
    renderSubmitReviewSummary(),
    isHost()
      ? button(nextLabel, proceedAfterSubmitReview, "primary")
      : el("p", { class: "muted-text" }, "ホストの確認待ち")
  ]);
}

function renderSubmitReviewSummary() {
  const room = appState.room;
  const round = room.currentRound;
  const afterPenalty = room.life;
  return el(
    "div",
    { class: "round-summary" },
    el("p", {}, `判定: ${round.lifeLost > 0 ? `失敗あり / ライフ -${round.lifeLost}` : "全成功"}`),
    el("p", {}, `ライフ: ${round.lifeBefore} → ${afterPenalty}`),
    afterPenalty > 0 ? el("p", { class: "muted-text" }, "次へ進むと生存ボーナスでライフが +1 されます。") : null
  );
}

function renderTableCards() {
  const round = appState.room.currentRound;
  const activeCards = round.cards.filter((card) => !card.revealed);
  const revealedCards = round.cards.filter((card) => card.revealed);

  return el(
    "div",
    { class: "table-wrap" },
    activeCards.length
      ? [
          el("h3", {}, "未公開カード"),
          el(
            "div",
            { class: "table-cards" },
            ...activeCards.map((card) => renderHintCard(card, false))
          )
        ]
      : null,
    revealedCards.length
      ? el(
          "div",
          { class: "revealed-zone" },
          el("h3", {}, "公開済み"),
          el("div", { class: "table-cards" }, ...revealedCards.map((card) => renderHintCard(card, true)))
        )
      : null
  );
}

function renderHintCard(card, revealed) {
  const player = getPlayer(card.playerId);
  const own = card.playerId === appState.playerId;
  const status = card.skipped ? "飛ばし" : card.submitted ? "提出" : "未公開";
  return el(
    "article",
    { class: `hint-card ${revealed ? "revealed" : ""} ${card.failed ? "failed" : ""}` },
    el(
      "div",
      { class: "hint-card-head" },
      el("span", {}, player ? player.name : "不明"),
      revealed || own ? el("strong", {}, String(card.number)) : el("strong", {}, "?")
    ),
    el("p", {}, card.text || "未入力"),
    el("div", { class: "hint-card-foot" }, pill(status, card.failed || card.skipped ? "danger" : revealed ? "ok" : "muted"))
  );
}

function renderOwnSubmitCards() {
  const cards = getOwnActiveRoundCards().filter((card) => !card.revealed);
  if (!cards.length) {
    return el("p", { class: "muted-text" }, "提出できる自分のカードはありません。");
  }
  return el(
    "div",
    { class: "own-submit" },
    el("h3", {}, "自分のカード"),
    el(
      "div",
      { class: "submit-grid" },
      ...cards.map((card) =>
        el(
          "div",
          { class: "submit-card" },
          el("strong", {}, String(card.number)),
          el("span", {}, card.text),
          button("提出", () => submitCard(card.id), "primary")
        )
      )
    )
  );
}

function renderSubmitLog() {
  const round = appState.room.currentRound;
  return el(
    "div",
    { class: "log-list" },
    el("h3", {}, "提出履歴"),
    ...round.submitLog.map((entry) => {
      const player = getPlayer(entry.playerId);
      const loss = entry.lifeLoss > 0 ? ` / ライフ -${entry.lifeLoss}` : "";
      return el(
        "div",
        { class: `log-row ${entry.success ? "success" : "failure"}` },
        el("span", {}, `${player ? player.name : "不明"}: ${entry.number}`),
        el("span", {}, `${entry.success ? "成功" : `失敗 ${entry.skippedCards.length}枚飛ばし`}${loss}`)
      );
    })
  );
}

function renderVote() {
  const round = appState.room.currentRound;
  const votedCount = Object.keys(round.votes || {}).length;
  const allVoted = votedCount >= appState.room.players.length;
  const ownVote = round.votes ? round.votes[appState.playerId] : undefined;

  return el(
    "div",
    { class: "content-grid" },
    panel("戦犯投票", [
      el(
        "form",
        { class: "stack", onsubmit: handleVoteSubmit },
        el(
          "fieldset",
          {},
          el("legend", {}, "投票先"),
          radio("target", "none", "戦犯なし", ownVote === null || ownVote === undefined, false),
          ...appState.room.players.map((player) => radio("target", player.id, player.name, ownVote === player.id, false))
        ),
        button("投票", null, "primary", { type: "submit" })
      )
    ]),
    panel("投票状況", [
      el("p", { class: "muted-text" }, `${votedCount}/${appState.room.players.length}`),
      el("p", { class: "muted-text" }, allVoted ? "集計して結果へ進みます。" : "全員が投票すると自動で結果へ進みます。")
    ])
  );
}

function renderRoundEnd() {
  const latest = getLatestLog();
  return panel(`ラウンド ${latest.roundNumber} 終了`, [
    renderRoundLogSummary(latest),
    isHost() ? button("次のラウンドへ", nextRound, "primary") : el("p", { class: "muted-text" }, "ホストの進行待ち")
  ]);
}

function renderGameOver() {
  const room = appState.room;
  const text = buildExportText(room);
  return panel("ゲーム結果", [
    el("textarea", { class: "export-text", readonly: true }, text),
    el("div", { class: "action-row" }, button("結果をコピー", () => copyText(text), "primary"), isHost() ? button("ロビーへ戻す", resetToLobby, "secondary") : null)
  ]);
}

function renderRoundLogSummary(log) {
  return el(
    "div",
    { class: "round-summary" },
    el("p", {}, `テーマ: ${log.theme}`),
    el("p", {}, `判定: ${log.life.lost > 0 ? `失敗あり / ライフ -${log.life.lost}` : "全成功"}`),
    el("p", {}, `ライフ: ${log.life.before} → ${log.life.afterPenalty} → ${log.life.after}`)
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
        el("span", { class: "player-meta" }, `戦犯 ${player.culpritTokens || 0}`)
      )
    )
  );
}

async function createRoom() {
  await runAction(async () => {
    const roomId = makeRoomId();
    const key = crypto.randomUUID();
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
      endReason: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    saveHostKey(roomId, key);
    setRoomUrl(roomId);
    appState.roomId = roomId;
    appState.playerId = null;
    appState.hostKey = key;
    await appState.store.create(room);
    setNotice(appState.syncMode === "firebase" ? "ルームを作成しました。共有URLから参加できます。" : "確認用ルームを作成しました。同じ通常ブラウザの別タブから参加できます。");
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
  if (!name) return setError("表示名を入力してください。");

  await runAction(async () => {
    const playerId = crypto.randomUUID();
    await appState.store.update((room) => {
      assertUniquePlayerName(room, name);
      room.players.push({
        id: playerId,
        name,
        culpritTokens: 0,
        joinedAt: nowIso()
      });
      return room;
    });
    appState.playerId = playerId;
    savePlayerId(appState.room.id, playerId);
    setNotice(`${name}で参加しました。`);
  });
}

function handleSettingsChange(event) {
  if (!isHost()) return;
  const settings = readSettingsFromForm(event.currentTarget);
  scheduleSettingsSave(settings);
}

function readSettingsFromForm(formElement) {
  const form = new FormData(formElement);
  return {
    maxRounds: clampInt(form.get("maxRounds"), 1, 20, 3),
    initialLife: clampInt(form.get("initialLife"), 1, 30, 3),
    cardIncrement: clampInt(form.get("cardIncrement"), 1, 20, 1),
    cardLimit: clampInt(form.get("cardLimit"), 1, 100, 5),
    sortMode: "pattern1",
    pattern1LifeRule: form.get("pattern1LifeRule") === "skipped" ? "skipped" : "flat",
    pattern2LifeRule: "flat",
    culpritTokens: form.get("culpritTokens") === "true",
    inputVisibility: form.get("inputVisibility") === "live" ? "live" : "afterWriting"
  };
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
    setNotice("設定を更新しました。");
  } catch (error) {
    setError(error.message || "設定の更新に失敗しました。");
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
      if (room.players.length < 1) throw new Error("参加者が必要です。");
      if (latestSettings) {
        room.settings = latestSettings;
      }
      room.phase = "theme";
      room.round = 0;
      room.life = room.settings.initialLife;
      room.currentRound = null;
      room.logs = [];
      room.endReason = null;
      room.players = room.players.map((player) => ({ ...player, culpritTokens: 0 }));
      return room;
    });
  });
}

async function handleThemeSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const theme = String(form.get("theme") || "").trim();
  if (!theme) return setError("テーマを入力してください。");

  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      const nextRound = room.round + 1;
      const cardsPerPlayer = getCardsPerPlayer(room, nextRound);
      if (cardsPerPlayer < 1) throw new Error("カードを配布できません。参加者数と上限を確認してください。");
      const cards = dealCards(room.players, cardsPerPlayer, nextRound);
      room.currentRound = {
        roundNumber: nextRound,
        theme,
        cards,
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

  await runAction(async () => {
    await appState.store.update((room) => {
      requirePhase(room, "writing");
      const round = room.currentRound;
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
    setNotice("入力を保存しました。");
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
      const card = round.cards.find((item) => item.id === cardId);
      if (!card) throw new Error("カードが見つかりません。");
      if (card.playerId !== appState.playerId) throw new Error("自分のカードだけ提出できます。");
      if (card.revealed) throw new Error("公開済みのカードです。");

      const activeCards = round.cards.filter((item) => !item.revealed);
      const skippedCards = activeCards.filter((item) => item.id !== card.id && item.number < card.number);
      const success = skippedCards.length === 0;
      const lifeLoss = success ? 0 : room.settings.pattern1LifeRule === "skipped" ? skippedCards.length : 1;
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
      const validTargets = new Set(room.players.map((player) => player.id));
      round.votes = round.votes || {};
      round.votes[appState.playerId] = target === "none" ? null : validTargets.has(target) ? target : null;
      if (Object.keys(round.votes).length >= room.players.length) {
        finalizeVote(room);
      }
      return room;
    });
    setNotice("投票しました。");
  });
}

async function closeVote() {
  await runAction(async () => {
    await appState.store.update((room) => {
      requireHost(room);
      requirePhase(room, "vote");
      const round = room.currentRound;
      if (Object.keys(round.votes || {}).length < room.players.length) {
        throw new Error("未投票の参加者がいます。");
      }
      finalizeVote(room);
      return room;
    });
  });
}

function finalizeVote(room) {
  const round = room.currentRound;
  const result = tallyVotes(room, round.votes || {});
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
      room.phase = "lobby";
      room.round = 0;
      room.life = room.settings.initialLife;
      room.currentRound = null;
      room.logs = [];
      room.endReason = null;
      return room;
    });
  });
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
    room.phase = "gameOver";
    room.endReason = "life";
    return;
  }

  if (room.round >= room.settings.maxRounds) {
    room.phase = "gameOver";
    room.endReason = "rounds";
    return;
  }

  room.phase = "roundEnd";
}

function buildRoundLog(room, round, afterPenalty, bonus) {
  return {
    roundNumber: round.roundNumber,
    theme: round.theme,
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
    votes: Object.entries(round.votes || {}).map(([playerId, targetId]) => ({
      playerId,
      playerName: getPlayerName(room, playerId),
      targetId,
      targetName: targetId ? getPlayerName(room, targetId) : "戦犯なし"
    })),
    completedAt: nowIso()
  };
}

function tallyVotes(room, votes) {
  const counts = { none: 0 };
  for (const player of room.players) counts[player.id] = 0;

  for (const targetId of Object.values(votes)) {
    if (targetId && counts[targetId] !== undefined) counts[targetId] += 1;
    else counts.none += 1;
  }

  const max = Math.max(...Object.values(counts));
  const winners = Object.entries(counts).filter(([, count]) => count === max);
  if (winners.length !== 1 || winners[0][0] === "none") {
    return { playerId: null, playerName: "戦犯なし", counts };
  }

  const playerId = winners[0][0];
  return { playerId, playerName: getPlayerName(room, playerId), counts };
}

function buildExportText(room) {
  const lines = [];

  for (const [index, log] of room.logs.entries()) {
    if (index > 0) lines.push("");
    lines.push(`--- テーマ：${log.theme} ---`);
    const culpritPlayerId = log.voteResult && log.voteResult.playerId ? log.voteResult.playerId : null;
    for (const card of [...log.cards].sort((a, b) => a.number - b.number)) {
      const culpritMark = card.playerId === culpritPlayerId ? " ★戦犯" : "";
      lines.push(`${card.playerName}：${card.text} (${card.number})${culpritMark}`);
    }
  }

  return lines.join("\n");
}

function normalizeRoom(room) {
  const settings = { ...DEFAULT_SETTINGS, ...(room.settings || {}) };
  return {
    id: room.id,
    hostKey: room.hostKey || "",
    phase: room.phase || "lobby",
    settings,
    players: Array.isArray(room.players) ? room.players : [],
    round: Number(room.round || 0),
    life: Number(room.life ?? settings.initialLife),
    currentRound: room.currentRound || null,
    logs: Array.isArray(room.logs) ? room.logs : [],
    endReason: room.endReason || null,
    createdAt: room.createdAt || nowIso(),
    updatedAt: room.updatedAt || nowIso()
  };
}

function dealCards(players, count, roundNumber) {
  const numbers = shuffle(Array.from({ length: 100 }, (_, index) => index + 1));
  let cursor = 0;
  const cards = [];
  for (const player of players) {
    for (let index = 0; index < count; index += 1) {
      cards.push({
        id: `r${roundNumber}-${player.id}-${index}-${numbers[cursor]}`,
        playerId: player.id,
        number: numbers[cursor],
        text: "",
        revealed: false,
        submitted: false,
        skipped: false,
        failed: false
      });
      cursor += 1;
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

function getOwnActiveRoundCards() {
  const round = appState.room.currentRound;
  if (!round) return [];
  return round.cards.filter((card) => card.playerId === appState.playerId);
}

function getLatestLog() {
  return appState.room.logs[appState.room.logs.length - 1];
}

function isHost() {
  return Boolean(appState.room && appState.hostKey && appState.room.hostKey === appState.hostKey);
}

function requireHost(room) {
  if (!appState.hostKey || room.hostKey !== appState.hostKey) throw new Error("ホスト操作です。");
}

function requirePhase(room, phase) {
  if (room.phase !== phase) throw new Error(`現在は${PHASE_LABELS[room.phase] || room.phase}フェーズです。`);
}

function assertUniquePlayerName(room, name) {
  const normalized = normalizeName(name);
  const exists = room.players.some((player) => normalizeName(player.name) === normalized);
  if (exists) throw new Error("同じ名前の参加者がいます。");
}

function normalizeName(name) {
  return name.trim().toLocaleLowerCase("ja-JP");
}

function sortModeLabel(value) {
  return value === "pattern2" ? "全カード一括判定" : "1枚ずつ提出";
}

function pattern1LifeRuleLabel(value) {
  return value === "skipped" ? "飛ばした枚数分" : "飛ばし時 -1";
}

function inputVisibilityLabel(value) {
  return value === "live" ? "随時公開" : "全員入力後";
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
  appState.store.disconnect();
  render();
}

function getShareUrl(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    setNotice("コピーしました。");
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

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(String(value), 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
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
      onclick: onClick || null
    },
    text
  );
}

function pill(text, tone = "muted") {
  return el("span", { class: `pill ${tone}` }, text);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class" || key === "className") {
      node.className = value;
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
