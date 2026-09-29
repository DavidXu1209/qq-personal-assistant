const HUB = location.protocol.startsWith("http") ? "" : "http://127.0.0.1:3789";
const els = Object.fromEntries([
  "stickerLibraryButton", "stickerBlacklistButton", "stickerLibraryCount", "stickerBlacklistCount", "stickerLibraryHelp",
  "connectionBadge", "refreshButton", "agentDispatchToggle", "agentDispatchLabel", "qzoneButton", "stickerGalleryButton", "stickerGalleryButtonCount",
  "workspace", "qzonePanel", "closeQzoneButton", "qzoneBanner", "qzoneForm", "qzoneTarget", "qzoneAutoPost", "qzonePostTimes", "qzoneAutoEngage", "qzoneLastSeenTime", "saveQzoneButton", "qzoneSaveStatus", "qzoneEvents", "stickerGallery", "closeStickerGalleryButton", "stickerReadyCount", "stickerRecognizingCount", "stickerCommitCount", "stickerGalleryModel", "stickerRecognitionStatus", "stickerGalleryActionStatus", "stickerGalleryGrid",
  "groupCount", "agentGroupCount", "sourceCount", "groupList", "privateList", "sourceList",
  "addGroupButton", "groupForm", "groupCandidate", "groupFormStatus", "reloadGroupCandidatesButton", "saveGroupButton", "cancelGroupButton",
  "addPrivateButton", "privateForm", "privateUserId", "privateDisplayName", "privateFormStatus", "savePrivateButton", "cancelPrivateButton",
  "hubStatus", "oneBotStatus", "codexStatus", "sessionDetails", "subscriptionDetails", "subscriptionCount", "subscriptionList",
  "agentSettingsDetails", "agentSettingsSummary", "agentSettingsForm", "agentModel", "agentReasoningEffort",
  "agentContextTokenLimit", "agentWorkingMode", "agentPermissionMode", "agentCalendarRemindersEnabled", "agentModeExplanation",
  "agentSettingsHint", "agentSettingsStatus", "saveAgentSettingsButton",
  "personaDetails", "personaSummary", "personaOwnerStyleSummary", "personaOwnerStyleRules", "personaPromptPreview",
  "stickerLabelDetails", "stickerLabelSummary", "stickerLabelForm", "stickerLabelModel", "stickerLabelStatus", "saveStickerLabelButton",
  "addSubscriptionButton", "subscriptionForm", "subscriptionId", "subscriptionSource", "subscriptionIntake",
  "subscriptionDelayLabel", "subscriptionDelay", "subscriptionEnabled", "cancelSubscriptionButton",
  "threadId", "threadLockState", "threadCreatedAt", "lastActivityAt", "pendingCount", "workerState", "triggerState",
  "selectedGroupId", "selectedGroupName", "activityStatus", "groupError", "sessionButton", "retryButton",
  "resetButton", "cancelButton", "replyControl", "replyEnabledToggle", "replyEnabledLabel", "replyEnabledHint", "conversation", "jumpToLatest", "composer", "promptInput", "sendButton"
].map((id) => [id, document.getElementById(id)]));

let state = null;
let maintenance = null;
let selectedKey = localStorage.getItem("crc-selected-target") || "";
let stream = null;
let refreshTimer = null;
let renderedKey = "";
let conversationSignature = "";
let navigationSignature = "";
let settingsSignature = "";
let settingsDirty = false;
let stickerLabelSignature = "";
let stickerLabelDirty = false;
let stickerGallerySignature = "";
let stickerGalleryView = "library";
let stickerEditingId = "";
let stickerEditDraft = "";
let stickerActionSavingId = "";
let qzoneDirty = false;
let replySwitchSaving = false;
let groupCandidatesLoading = false;
const scrollState = new Map();

async function api(path, options = {}) {
  const token = localStorage.getItem("crc-hub-token") || "";
  const response = await fetch(`${HUB}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function refresh() {
  setConnection("正在连接", "neutral");
  try {
    [state, maintenance] = await Promise.all([api("/api/state"), api("/api/maintenance")]);
    render();
    setConnection("已连接", "good");
  } catch (error) {
    setConnection(error.message, "bad");
  }
}

function render() {
  const all = allItems();
  if (!all.some((item) => item.key === selectedKey)) {
    rememberCurrentScroll();
    selectedKey = all[0]?.key || "";
    conversationSignature = "";
  }
  localStorage.setItem("crc-selected-target", selectedKey);
  renderNavigation(all);
  renderServices();
  const selected = all.find((item) => item.key === selectedKey) || null;
  renderSelected(selected);
  renderConversation(selected);
  renderAgentSettings(selected);
  renderPersona(selected);
  renderStickerLabelSettings();
  renderSubscriptions(selected);
  renderStickerGallery();
  renderQzone();
  renderView();
}

function renderView() {
  const galleryOpen = location.hash === "#stickers";
  const qzoneOpen = location.hash === "#qzone";
  els.workspace.hidden = galleryOpen || qzoneOpen;
  els.stickerGallery.hidden = !galleryOpen;
  els.qzonePanel.hidden = !qzoneOpen;
  els.stickerGalleryButton.setAttribute("aria-pressed", String(galleryOpen));
  els.stickerGalleryButton.classList.toggle("selected", galleryOpen);
  els.qzoneButton.setAttribute("aria-pressed", String(qzoneOpen));
  els.qzoneButton.classList.toggle("selected", qzoneOpen);
}

function renderQzone() {
  const config = state?.qq?.qzone || {};
  const choices = allItems().filter((item) => item.kind === "group" || (item.kind === "private" && item.data.targetId === state?.qq?.ownerId));
  const current = config.targetType && config.targetId ? `${config.targetType}:${config.targetId}` : "";
  const options = `<option value="">暂不绑定</option>${choices.map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.kind === "group" ? `群聊 · ${itemName(item)}` : `私聊 · ${itemName(item)}`)}</option>`).join("")}`;
  if (!qzoneDirty) {
    if (els.qzoneTarget.innerHTML !== options) els.qzoneTarget.innerHTML = options;
    els.qzoneTarget.value = choices.some((item) => item.key === current) ? current : "";
    els.qzoneAutoPost.checked = Boolean(config.autoPostEnabled);
    els.qzoneAutoEngage.checked = Boolean(config.autoEngageEnabled);
  }
  const bound = choices.find((item) => item.key === current);
  const enabled = Boolean(state?.agentDispatch?.enabled ?? true);
  const warning = !enabled ? "Agent 总开关已关闭，手动发布与定时任务都暂停。" : !bound ? "你可以在任一 Agent 会话中手动发动态；自动任务尚未绑定会话。" : bound.data.replyEnabled === false ? "绑定会话的定时任务暂停；其他可回复会话仍允许你手动发动态。" : "你可在任一 Agent 会话中手动发动态；定时任务使用这里选定的会话。";
  els.qzoneBanner.textContent = warning;
  els.qzoneBanner.className = `recognition-status ${enabled ? "active" : "waiting"}`;
  els.qzonePostTimes.textContent = `沿用现有早中晚时间：${(config.scheduleTimes || []).join("、") || "未配置"}（北京时间）。每个时段可自行跳过。`;
  els.qzoneLastSeenTime.textContent = `上次读到的最新动态发布时间：${config.lastSeenFeedTimeMs ? formatTime(config.lastSeenFeedTimeMs) : "尚无"}。新动态按发布时间判断；同一秒内按记录去重。`;
  const events = (config.events || []).slice(0, 15);
  els.qzoneEvents.innerHTML = events.length ? events.map((event) => `<article><span>${escapeHtml(formatTime(event.at))} · ${escapeHtml(({"scheduled-post":"定时发动态",post:"手动发动态","feed-scan":"好友动态检查",like:"点赞",comment:"评论",error:"错误"})[event.kind] || event.kind)}</span><strong>${escapeHtml(event.message || event.status || "")}</strong></article>`).join("") : '<p class="empty compact">尚无任务记录。设置默认关闭，保存后才开始运行。</p>';
}

function renderStickerGallery() {
  const stickers = state?.qq?.stickers || {};
  const items = [...(stickers.items || [])].sort((a, b) => stickerTimestamp(b) - stickerTimestamp(a));
  const candidates = [...(stickers.candidates || [])].sort((a, b) => stickerTimestamp(b) - stickerTimestamp(a));
  const excluded = [...(stickers.excludedItems || [])].sort((a, b) => stickerTimestamp(b) - stickerTimestamp(a));
  const blacklist = stickerGalleryView === "blacklist";
  els.stickerLibraryCount.textContent = String(items.length + candidates.length);
  els.stickerBlacklistCount.textContent = String(stickers.excludedCount || 0);
  els.stickerLibraryButton.setAttribute("aria-pressed", String(!blacklist));
  els.stickerBlacklistButton.setAttribute("aria-pressed", String(blacklist));
  els.stickerLibraryButton.classList.toggle("selected", !blacklist);
  els.stickerBlacklistButton.classList.toggle("selected", blacklist);
  els.stickerLibraryHelp.textContent = blacklist
    ? "黑名单中的表情不再识别、入库或供老代发送。移出可恢复收录；彻底删除会忘记所有指纹，下次收到按新表情处理。旧记录可能没有预览。"
    : "移入黑名单会保留预览和备注，阻止再次收录；彻底删除则忘记该表情，下次收到重新识别。";
  const awaitingAi = Number(stickers.awaitingAi || 0);
  const awaitingCommit = Number(stickers.awaitingCommit || 0);
  const model = stickers.labeling?.model || "—";
  els.stickerGalleryButtonCount.textContent = String(items.length + candidates.length);
  els.stickerReadyCount.textContent = String(items.length);
  els.stickerRecognizingCount.textContent = String(awaitingAi);
  els.stickerCommitCount.textContent = String(awaitingCommit);
  els.stickerGalleryModel.textContent = modelInfo(model)?.displayName || model;

  let statusText = "识别队列空闲，新表情到达后会自动去重并标注。";
  let statusTone = "idle";
  if (awaitingAi > 0) {
    statusText = `正在识别 ${awaitingAi} 个新表情，结果会实时出现在这里。`;
    statusTone = "active";
  } else if (awaitingCommit > 0) {
    statusText = `${awaitingCommit} 个表情已完成识别，正在等待当前聊天回复结束后入库。`;
    statusTone = "waiting";
  }
  els.stickerRecognitionStatus.className = `recognition-status ${statusTone}`;
  els.stickerRecognitionStatus.innerHTML = `<span class="status-dot" aria-hidden="true"></span><span>${escapeHtml(statusText)}</span>`;
  const curation = stickers.curation;
  const curationEl = document.getElementById("stickerCurationStatus");
  let curationText = "每天 05:00（北京时间）检查；超过 100 个时用当前识图模型筛选到 80 个。";
  if (curation?.status === "queued") curationText = "表情筛选已排队，等待 Agent 总开关开启；消息继续收集。";
  else if (curation?.status === "waiting") curationText = "表情筛选等待正在进行的任务结束；新的回复和识别任务正在排队，消息继续收集。";
  else if (curation?.status === "running") curationText = `正在筛选：已看 ${curation.progress?.reviewed || 0}/${curation.beforeCount || 0} 个${curation.progress?.phase === "selection" ? "，正在决定保留名单" : ""}。回复和新表情识别暂时排队；消息继续收集。`;
  else if (curation?.status === "completed") curationText = `上次筛选保留 ${curation.retainedCount} 个，移除 ${curation.removedCount} 个；回复和识别已恢复。每天 05:00 再检查。`;
  else if (curation?.status === "skipped") curationText = `上次检查 ${curation.beforeCount} 个，未超过 100 个，无需筛选。每天 05:00 再检查。`;
  else if (curation?.status === "failed") curationText = `筛选失败：${curation.error || "模型未返回有效结果"}。回复和识别已恢复；下一次 05:00 再检查。`;
  if (curationEl) { if (curationEl.textContent !== curationText) curationEl.textContent = curationText; curationEl.className = `recognition-status ${["waiting", "running"].includes(curation?.status) ? "waiting" : "idle"}`; }

  const signature = JSON.stringify([items, candidates, excluded, stickerGalleryView, model, statusText, stickerEditingId, stickerEditDraft, stickerActionSavingId]);
  if (signature === stickerGallerySignature) return;
  stickerGallerySignature = signature;
  const cards = blacklist ? excluded.map((item) => renderStickerCard(item, false, true)) : [
    ...candidates.map((candidate) => renderStickerCard(candidate, true)),
    ...items.map((item) => renderStickerCard(item, false))
  ];
  els.stickerGalleryGrid.innerHTML = cards.length
    ? cards.join("")
    : blacklist ? '<div class="gallery-empty"><strong>黑名单为空</strong><span>手动移入或自动筛选排除的表情会出现在这里。</span></div>'
    : '<div class="gallery-empty"><strong>还没有收录表情</strong><span>群里出现新的 QQ 原生表情包后，会在这里显示识别进度和使用场景。</span></div>';
}

function renderStickerCard(item, candidate, blacklisted = false) {
  const status = blacklisted ? { label: "黑名单", tone: "waiting" } : candidate ? stickerCandidateStatus(item.status) : { label: "已入库", tone: "ready" };
  const description = candidate
    ? (item.usage || item.labelError || (item.status === "labeling" ? "正在读取画面并生成使用场景…" : "等待识别…"))
    : item.usage || (blacklisted ? "历史排除记录，暂无备注" : "");
  const imageUrl = stickerImageUrl(item.id, item.lastSeenAt || item.createdAt);
  const counts = blacklisted ? `${item.reason === "curation" ? "自动筛选排除" : "手动移入"} · 排除后又收到 ${Number(item.receiveCount || 0)} 次` : candidate
    ? `收到 ${Number(item.receiveCount || 0)} 次`
    : `收到 ${Number(item.receiveCount || 0)} 次 · 发送 ${Number(item.sendCount || 0)} 次`;
  const editing = !candidate && stickerEditingId === item.id;
  const saving = stickerActionSavingId === item.id;
  const actions = blacklisted
    ? `<div class="sticker-card-actions"><button class="button ghost" type="button" data-restore-sticker="${escapeHtml(item.id)}" ${saving ? "disabled" : ""}>${item.canRestore ? "恢复到表情库" : "解除黑名单"}</button><button class="button danger" type="button" data-forget-sticker="${escapeHtml(item.id)}" ${saving ? "disabled" : ""}>彻底删除并忘记</button></div>`
    : candidate ? "" : editing
    ? `<form class="sticker-edit-form" data-sticker-edit-form="${escapeHtml(item.id)}">
        <label for="sticker-usage-${escapeHtml(item.id)}">使用场景备注</label>
        <textarea id="sticker-usage-${escapeHtml(item.id)}" name="usage" rows="3" maxlength="80" required>${escapeHtml(stickerEditDraft)}</textarea>
        <span class="field-note">写清楚适合在什么语境下使用，保存后会同步给 Agent。</span>
        <div class="sticker-edit-actions"><button class="button primary" type="submit" ${saving ? "disabled" : ""}>${saving ? "保存中…" : "保存备注"}</button><button class="button ghost" type="button" data-cancel-sticker-edit ${saving ? "disabled" : ""}>取消</button></div>
      </form>`
    : `<div class="sticker-card-actions"><button class="button ghost" type="button" data-edit-sticker="${escapeHtml(item.id)}" ${saving ? "disabled" : ""}>修改备注</button><button class="button ghost" type="button" data-delete-sticker="${escapeHtml(item.id)}" ${saving ? "disabled" : ""}>移入黑名单</button><button class="button danger" type="button" data-forget-sticker="${escapeHtml(item.id)}" ${saving ? "disabled" : ""}>彻底删除并忘记</button></div>`;
  return `<article class="sticker-card ${candidate ? "candidate" : ""}" data-sticker-id="${escapeHtml(item.id)}">
    <div class="sticker-preview">${blacklisted && !item.hasPreview ? '<span class="sticker-preview-placeholder">旧记录暂无预览<br>再次收到时会补回预览，不触发识别</span>' : `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(description || "待识别表情")}" loading="${candidate ? "eager" : "lazy"}" />`}</div>
    <div class="sticker-card-body">
      <div class="sticker-card-meta"><span class="sticker-state ${status.tone}">${escapeHtml(status.label)}</span><time>${escapeHtml(formatTime(item.lastSeenAt || item.excludedAt || item.createdAt))}</time></div>
      <p>${escapeHtml(description || "等待识别…")}</p>
      <small>${escapeHtml(counts)} · ${escapeHtml(item.id)}</small>
      ${actions}
    </div>
  </article>`;
}

function stickerCandidateStatus(value) {
  return ({
    awaiting_ai: { label: "等待识别", tone: "waiting" },
    labeling: { label: "识别中", tone: "recognizing" },
    ready_to_commit: { label: "等待入库", tone: "waiting" },
    label_failed: { label: "识别失败", tone: "failed" }
  })[value] || { label: "处理中", tone: "waiting" };
}

function stickerTimestamp(item) {
  return Date.parse(item?.lastSeenAt || item?.excludedAt || item?.createdAt || 0) || 0;
}

function stickerImageUrl(id, version) {
  const token = localStorage.getItem("crc-hub-token") || "";
  const parameters = new URLSearchParams();
  if (version) parameters.set("v", String(version));
  if (token) parameters.set("access_token", token);
  const query = parameters.toString();
  return `${HUB}/api/qq/stickers/${encodeURIComponent(id)}/image${query ? `?${query}` : ""}`;
}

function allItems() {
  const qq = state?.qq || {};
  return [
    ...Object.values(qq.groups || {}).map((data) => ({ key: `group:${data.targetId || data.groupId}`, kind: "group", data })),
    ...Object.values(qq.privateChats || {}).map((data) => ({ key: `private:${data.targetId || data.userId}`, kind: "private", data })),
    ...Object.values(qq.sourceGroups || {}).map((data) => ({ key: `source:${data.groupId}`, kind: "source", data }))
  ];
}

function renderNavigation(all) {
  const groups = all.filter((item) => item.kind === "group");
  const privateChats = all.filter((item) => item.kind === "private");
  const sources = all.filter((item) => item.kind === "source");
  els.groupCount.textContent = String(all.length);
  els.agentGroupCount.textContent = String(groups.length);
  els.sourceCount.textContent = String(sources.length);
  const signature = JSON.stringify(all.map((item) => [item.key, itemName(item), item.data.replyEnabled, item.data.pendingCount, item.data.retainedCount, item.data.visibleCount, item.data.pendingSubscriberCount, item.data.failedSubscriberCount, item.data.activeReply?.running, item.data.threadLock?.status, item.data.subscriptions?.length, item.key === selectedKey]));
  if (signature === navigationSignature) return;
  navigationSignature = signature;
  els.groupList.innerHTML = groups.length ? groups.map(renderNavigationButton).join("") : '<p class="empty compact">尚未配置 Agent 群</p>';
  els.privateList.innerHTML = privateChats.length ? privateChats.map(renderNavigationButton).join("") : '<p class="empty compact">尚未配置 Agent 私聊</p>';
  els.sourceList.innerHTML = sources.length ? sources.map(renderNavigationButton).join("") : '<p class="empty compact">添加订阅后会显示通知源</p>';
}

function renderNavigationButton(item) {
  const data = item.data;
  const selected = item.key === selectedKey;
  let status = "空闲";
  let tone = "idle";
  if (item.kind === "source") {
    status = data.failedSubscriberCount ? "需重试" : data.pendingSubscriberCount ? `${data.pendingSubscriberCount} 待完成` : "只读";
    tone = data.failedSubscriberCount ? "error" : data.pendingSubscriberCount ? "pending" : "idle";
  } else if (data.replyEnabled === false) {
    status = "不回复";
    tone = "idle";
  } else if (data.activeReply?.uploading) {
    status = "传文件";
    tone = "running";
  } else if (data.activeReply?.waiting) {
    status = "接话运行中";
    tone = "running";
  } else if (data.activeReply?.running || data.busy) {
    status = "回复中";
    tone = "running";
  } else if (data.lastError) {
    status = "异常";
    tone = "error";
  } else if (["external_writer", "error"].includes(data.threadLock?.status)) {
    status = data.threadLock.status === "external_writer" ? "被占用" : "未锁定";
    tone = "error";
  } else if (data.pendingTrigger?.reason === "mention") {
    status = "待处理";
    tone = "attention";
  } else if (data.pendingCount > 0) {
    status = String(data.pendingCount);
    tone = "pending";
  }
  const subtitle = item.kind === "group" ? `群 ${data.targetId}` : item.kind === "private" ? `私聊 ${data.targetId}` : `来源群 ${data.groupId}`;
  return `
    <button class="group-button ${selected ? "selected" : ""}" type="button" data-target-key="${escapeHtml(item.key)}" ${selected ? 'aria-current="true"' : ""}>
      <span class="group-copy"><strong>${escapeHtml(itemName(item))}</strong><small>${escapeHtml(subtitle)}</small></span>
      <span class="group-status ${tone}">${escapeHtml(status)}</span>
    </button>`;
}

function renderServices() {
  const dispatchEnabled = state?.agentDispatch?.enabled !== false;
  els.agentDispatchToggle.checked = dispatchEnabled;
  els.agentDispatchLabel.textContent = dispatchEnabled ? "Agent 已开启" : "Agent 已暂停";
  els.hubStatus.textContent = maintenance?.hub ? "运行中" : "未知";
  els.oneBotStatus.textContent = maintenance?.oneBot?.ok ? `${maintenance.oneBot.login?.nickname || "QQ"} 在线` : (maintenance?.oneBot?.error || "离线");
  const active = state?.qq?.activeTargets || [];
  els.codexStatus.textContent = !dispatchEnabled ? "已暂停 · 仅记录消息" : active.length ? `${active.length} 个会话处理中` : "空闲";
}

function renderSelected(item) {
  const data = item?.data || null;
  const source = item?.kind === "source";
  const active = source ? { running: false } : getActiveReply(data);
  const replyEnabled = data?.replyEnabled !== false;
  els.replyControl.hidden = !item || source;
  els.replyEnabledToggle.checked = replyEnabled;
  els.replyEnabledToggle.disabled = replySwitchSaving;
  els.replyEnabledLabel.textContent = replyEnabled ? "允许回复" : "不回复";
  els.replyEnabledHint.textContent = !replyEnabled ? "消息继续记录" : state?.agentDispatch?.enabled === false ? "总开关已暂停" : "仅影响当前会话";
  els.sessionDetails.hidden = !item || source;
  els.agentSettingsDetails.hidden = !item || source;
  els.personaDetails.hidden = !item || source;
  els.subscriptionDetails.hidden = !item || source;
  els.threadId.textContent = source ? "只读来源" : (data?.threadId || "尚未创建");
  els.threadId.title = data?.threadId || "";
  els.threadLockState.textContent = source ? "不适用" : formatThreadLock(data?.threadLock);
  els.threadLockState.title = data?.threadLock?.error || "";
  els.threadCreatedAt.textContent = source ? "—" : formatTime(data?.threadCreatedAt);
  els.lastActivityAt.textContent = formatTime(data?.lastActivityAt);
  els.pendingCount.textContent = String(source ? (data?.visibleCount || 0) : (data?.pendingCount || 0));
  els.workerState.textContent = source ? "不运行" : (active.waiting ? "运行中 · 等待接话" : (active.uploading ? "传文件" : (active.running ? "回复中" : (data?.busy ? "处理中" : "空闲"))));
  els.triggerState.textContent = source ? "禁止触发" : formatTrigger(data?.pendingTrigger?.reason);
  els.selectedGroupId.textContent = !item ? "QQ AGENT" : item.kind === "group" ? `AGENT 群 · ${data.targetId}` : item.kind === "private" ? `AGENT 私聊 · ${data.targetId}` : `只读通知源 · ${data.groupId}`;
  els.selectedGroupName.textContent = item ? itemName(item) : "选择一个会话";
  if (!item) els.activityStatus.textContent = "尚未配置可查看的会话";
  else if (source) els.activityStatus.textContent = data.pendingSubscriberCount
    ? `${data.pendingSubscriberCount} / ${data.subscriptionCount || 0} 个订阅会话尚未完成；全部送达后才清理来源消息`
    : `${data.subscriptionCount || 0} 个会话订阅 · 当前没有待发送通知`;
  else if (!replyEnabled) els.activityStatus.textContent = "本会话不回复 · 消息继续记录，重新开启后继续处理";
  else if (state?.agentDispatch?.enabled === false) els.activityStatus.textContent = "总开关已暂停 · 消息继续记录";
  else if (active.uploading) els.activityStatus.textContent = active.text || "QQ 正在上传文件…";
  else if (active.waiting) els.activityStatus.textContent = "接话运行中 · 新消息立即续接，连续两分钟无人发消息后结束";
  else if (active.running) els.activityStatus.textContent = active.trigger === "subscription_auto" ? "WorkBuddy 正在整理自动通知…" : "WorkBuddy 正在回复…";
  else if (data.threadLock?.status === "external_writer") els.activityStatus.textContent = "会话被其他写入端占用，网关会自动重试";
  else if (data.threadLock?.status === "error") els.activityStatus.textContent = "会话暂未锁定，网关会自动重试";
  else if (data.lastError || active.error) els.activityStatus.textContent = "本次回复失败，消息仍保留";
  else if (data.pendingCount > 0) els.activityStatus.textContent = `${data.pendingCount} 条消息等待处理`;
  else els.activityStatus.textContent = "消息已处理完毕";
  const error = source ? "" : (data?.lastError || active.error || "");
  els.groupError.hidden = !error;
  els.groupError.textContent = error ? `本次回复失败，消息尚未标记为已处理。${error}` : "";
  els.cancelButton.hidden = source || !item;
  els.cancelButton.disabled = !active.running;
  els.composer.hidden = source || !item;
  els.sendButton.disabled = !item || source;
  els.promptInput.disabled = !item || source;
  if (item && !source) els.promptInput.placeholder = item.kind === "private" ? "以 OWNER 身份发起这段私聊 Agent 对话……" : "以 OWNER 身份向当前群发起 Agent 对话……";
}

function renderAgentSettings(item) {
  if (!item || item.kind === "source") return;
  const data = item.data;
  const config = data.codexConfig || {
    model: state?.ai?.model,
    reasoningEffort: state?.ai?.reasoningEffort,
    contextTokenLimit: state?.ai?.autoCompactTokenLimit,
    workingMode: "agent",
    permissionMode: "workspaceWrite",
    calendarRemindersEnabled: true
  };
  const model = modelInfo(config.model);
  els.agentSettingsSummary.textContent = `${workModeLabel(config.workingMode)} · ${permissionModeLabel(config.permissionMode)} · ${model?.displayName || config.model || "默认"} · ${effortLabel(config.reasoningEffort)} · 自动化${config.calendarRemindersEnabled === false ? "关" : "开"}`;
  const nextSignature = JSON.stringify([item.key, config, state?.ai?.availableModels, state?.ai?.contextTokenOptions, state?.ai?.workModeOptions, state?.ai?.permissionModeOptions]);
  if (!settingsDirty && settingsSignature !== nextSignature) {
    populateModelOptions(config.model);
    populateEffortOptions(config.reasoningEffort);
    populateContextOptions(config.contextTokenLimit);
    populateWorkModeOptions(config.workingMode);
    populatePermissionOptions(config.permissionMode, item.kind);
    els.agentCalendarRemindersEnabled.checked = config.calendarRemindersEnabled !== false;
    settingsSignature = nextSignature;
  }
  updateParameterExplanation(item);
  const busy = Boolean(data.busy || data.activeReply?.running);
  const readOnlyMode = ["plan", "ask"].includes(els.agentWorkingMode.value);
  for (const control of [els.agentModel, els.agentReasoningEffort, els.agentContextTokenLimit, els.agentWorkingMode]) control.disabled = busy;
  els.agentPermissionMode.disabled = busy;
  els.agentCalendarRemindersEnabled.disabled = busy;
  els.saveAgentSettingsButton.disabled = busy || !settingsDirty;
  els.agentSettingsHint.textContent = busy
    ? "WorkBuddy 正在处理本轮消息，结束后即可修改；未保存的选择会保留。"
    : readOnlyMode
      ? "Plan / Ask 当前轮始终只读；仍可修改并保存执行权限，切回 Agent 后按所选权限生效。"
      : item.kind === "group" && els.agentPermissionMode.value === "dangerFullAccess"
        ? "保存后从下一轮起生效；当前群的所有成员都能通过老代操作本机和发送本机文件。"
        : "保存后从下一轮起生效；历史 thread 不变。本轮身份规则仍可继续收窄权限。";
}

function renderPersona(item) {
  if (!item || item.kind === "source") return;
  const persona = state?.persona || {};
  const publishedStyle = persona.publishedStyle || {};
  els.personaSummary.textContent = "所有会话共用";
  els.personaOwnerStyleSummary.textContent = publishedStyle.summarizedAt
    ? `最近更新 ${formatTime(publishedStyle.summarizedAt)}` : "尚未总结";
  const learnedRules = publishedStyle.rules || [];
  els.personaOwnerStyleRules.innerHTML = learnedRules.length
    ? learnedRules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")
    : "<li>尚无已发布的表达规则。</li>";
  els.personaPromptPreview.textContent = persona.promptPreview || "—";
}

function renderStickerLabelSettings() {
  const labeling = state?.qq?.stickers?.labeling || { model: "hy3" };
  const model = modelInfo(labeling.model);
  els.stickerLabelSummary.textContent = `${model?.displayName || labeling.model || "hy3"} · 临时会话`;
  const nextSignature = JSON.stringify([labeling.model, state?.ai?.availableModels]);
  if (!stickerLabelDirty && stickerLabelSignature !== nextSignature) {
    const models = [...(state?.ai?.availableModels || [])];
    if (labeling.model && !models.some((item) => item.model === labeling.model)) {
      models.unshift({ model: labeling.model, displayName: `${labeling.model}（当前已保存）` });
    }
    els.stickerLabelModel.innerHTML = models
      .map((item) => `<option value="${escapeHtml(item.model)}">${escapeHtml(item.displayName || item.model)}</option>`)
      .join("");
    els.stickerLabelModel.value = labeling.model || models[0]?.model || "";
    stickerLabelSignature = nextSignature;
  }
  els.saveStickerLabelButton.disabled = !stickerLabelDirty;
}

function populateModelOptions(selectedModel) {
  const models = [...(state?.ai?.availableModels || [])];
  if (selectedModel && !models.some((item) => item.model === selectedModel)) {
    models.unshift({ model: selectedModel, displayName: selectedModel, supportedReasoningEfforts: [] });
  }
  els.agentModel.innerHTML = models.map((item) => `<option value="${escapeHtml(item.model)}">${escapeHtml(item.displayName || item.model)}</option>`).join("");
  els.agentModel.value = selectedModel || models[0]?.model || "";
}

function populateEffortOptions(selectedEffort) {
  const model = modelInfo(els.agentModel.value);
  const efforts = model?.supportedReasoningEfforts || [];
  let selected = selectedEffort;
  if (!efforts.some((item) => item.reasoningEffort === selected)) selected = model?.defaultReasoningEffort || efforts[0]?.reasoningEffort || "low";
  els.agentReasoningEffort.innerHTML = efforts.map((item) => `<option value="${escapeHtml(item.reasoningEffort)}">${escapeHtml(effortLabel(item.reasoningEffort))}</option>`).join("");
  els.agentReasoningEffort.value = selected;
}

function populateContextOptions(selectedLimit) {
  const options = [...(state?.ai?.contextTokenOptions || [])];
  const selected = selectedLimit === "auto" ? "auto" : Number(selectedLimit || 0);
  if (selected && !options.some((item) => String(item.value) === String(selected))) {
    options.unshift({ value: selected, label: `自定义 · ${formatTokenLimit(selected)}` });
  }
  els.agentContextTokenLimit.innerHTML = options.map((item) => `<option value="${escapeHtml(String(item.value))}" title="${escapeHtml(item.description || "")}">${escapeHtml(item.label || formatTokenLimit(item.value))}</option>`).join("");
  els.agentContextTokenLimit.value = String(selected || options[0]?.value || "");
}

function populateWorkModeOptions(selectedMode) {
  const options = [...(state?.ai?.workModeOptions || [])];
  els.agentWorkingMode.innerHTML = options.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join("");
  els.agentWorkingMode.value = selectedMode || options[0]?.value || "agent";
}

function populatePermissionOptions(selectedPermission, targetType) {
  const options = (state?.ai?.permissionModeOptions || []).filter((item) => (item.targetTypes || []).includes(targetType));
  els.agentPermissionMode.innerHTML = options.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join("");
  els.agentPermissionMode.value = options.some((item) => item.value === selectedPermission)
    ? selectedPermission
    : (options[0]?.value || "readOnly");
}

function updateParameterExplanation(item) {
  const model = modelInfo(els.agentModel.value);
  const effort = model?.supportedReasoningEfforts?.find((entry) => entry.reasoningEffort === els.agentReasoningEffort.value);
  const context = (state?.ai?.contextTokenOptions || []).find((entry) => String(entry.value) === els.agentContextTokenLimit.value);
  const mode = (state?.ai?.workModeOptions || []).find((entry) => entry.value === els.agentWorkingMode.value);
  const permission = (state?.ai?.permissionModeOptions || []).find((entry) => entry.value === els.agentPermissionMode.value);
  const capabilityNote = model?.reasoningCapabilitySource === "workbuddy-cli-global"
    ? "WorkBuddy 当前只公开全局 6 档，未提供逐模型能力矩阵；不支持的档位会由模型忽略。"
    : (model?.description || "");
  const permissionWarning = item.kind === "group" && permission?.value === "dangerFullAccess"
    ? "；高风险：群内任何成员触发老代后都可读取、修改本机文件并发送本机文件到本群，通知源仍保持只读"
    : "";
  els.agentModeExplanation.innerHTML = [
    `<p><strong>${escapeHtml(mode?.label || "工作模式")}</strong>${escapeHtml(mode?.description || "")}</p>`,
    `<p><strong>${escapeHtml(permission?.label || "执行权限")}</strong>${escapeHtml(permission?.description || "")}${escapeHtml(permissionWarning)}</p>`,
    `<p><strong>${escapeHtml(effortLabel(els.agentReasoningEffort.value))} · ${escapeHtml(formatTokenLimit(els.agentContextTokenLimit.value))}</strong>${escapeHtml([effort?.description, context?.description, capabilityNote].filter(Boolean).join("；"))}</p>`,
    `<p><strong>通知自动化${els.agentCalendarRemindersEnabled.checked ? "已开启" : "已关闭"}</strong>${els.agentCalendarRemindersEnabled.checked ? "AUTO 通知可写入指定日历和“待办”提醒列表；写入成功后会在 QQ 回复中确认。" : "AUTO 通知仍会整理并回复，但网关不会执行日历或提醒事项写入。"}</p>`
  ].join("");
}

function modelInfo(model) {
  return (state?.ai?.availableModels || []).find((item) => item.model === model) || null;
}

function markSettingsDirty() {
  settingsDirty = true;
  els.agentSettingsStatus.textContent = "有未保存的修改";
  els.agentSettingsStatus.className = "form-status";
  renderAgentSettings(currentTarget());
}

function renderConversation(item) {
  if (!item) {
    replaceConversation('<div class="empty-state"><strong>没有可显示的会话</strong><span>请先配置 Agent 群或私聊。</span></div>', "", true);
    return;
  }
  if (item.kind === "source") {
    const data = item.data;
    const messages = data.visibleMessages || data.retainedMessages || [];
    const signature = `${item.key}:${JSON.stringify([messages, data.subscriberProgress, data.retainedCount])}`;
    const blocks = [
      '<section class="read-only-banner"><strong>只读通知源</strong><span>每个订阅会话分别处理；只有全部目标成功回复后才清理被引用的来源消息。最近十条上下文缓冲可能继续显示，但不代表仍待发送。Agent 不会向来源群回复。</span></section>',
      renderSourceProgress(data)
    ];
    if (messages.length) {
      const detail = data.retainedCount
        ? `${data.retainedCount} 条仍被订阅引用 · ${data.recentCount || 0} 条近期缓冲`
        : `${data.recentCount || messages.length} 条近期缓冲`;
      blocks.push(`<section class="conversation-section pending-section"><div class="section-label"><span>最近来源消息</span><span>${escapeHtml(detail)}</span></div><div class="message-stack">${messages.map((message) => renderMessage(message, false, true)).join("")}</div></section>`);
    } else {
      blocks.push('<div class="empty-state"><strong>暂无近期消息</strong><span>新通知会实时显示；全部订阅目标送达后，被引用的来源消息才会清理。</span></div>');
    }
    replaceConversation(blocks.join(""), signature, false, item.key);
    return;
  }

  const data = item.data;
  const active = getActiveReply(data);
  const relevantState = { lastCompletedReply: data.lastCompletedReply, pendingMessages: data.pendingMessages, processing: data.processing, activeReply: active, lastError: data.lastError, failedDelivery: data.failedDelivery };
  const signature = `${item.key}:${JSON.stringify(relevantState)}`;
  if (renderedKey === item.key && conversationSignature === signature) return;
  const blocks = [];
  if (data.lastCompletedReply?.text) {
    blocks.push(`<section class="conversation-section last-reply"><div class="section-label"><span>上一次完整回答</span><time>${formatTime(data.lastCompletedReply.completedAt)}</time></div>${renderReply(data.lastCompletedReply.text)}</section>`);
  }
  if ((data.pendingMessages || []).length) {
    const cutoff = data.processing?.kind === "agent" ? Number(data.processing.cutoffSequence || 0) : 0;
    const label = item.kind === "private" ? "尚未处理的私聊消息" : "尚未处理的群消息";
    blocks.push(`<section class="conversation-section pending-section"><div class="section-label"><span>${label}</span><span>${data.pendingMessages.length} 条${cutoff ? " · 回复成功后提交" : ""}</span></div><div class="message-stack">${data.pendingMessages.map((message) => renderMessage(message, Number(message.sequence || 0) <= cutoff)).join("")}</div></section>`);
  }
  if (active.waiting) {
    blocks.push('<section class="conversation-section active-section" role="status"><div class="section-label"><span>老代正在等待接话</span><span class="running-label"><i></i>运行中</span></div><article class="bubble agent live"><div class="bubble-text">新消息到达会立即继续判断<br>连续两分钟无人发消息后才结束；等待期间不调用模型</div></article></section>');
  } else if (active.running) {
    blocks.push(`<section class="conversation-section active-section"><div class="section-label"><span>WorkBuddy 正在回复</span><span class="running-label"><i></i>实时生成</span></div><article class="bubble agent live"><div class="bubble-meta"><strong>老代 · WorkBuddy</strong><span>${escapeHtml(formatTrigger(active.trigger))}</span></div><div class="bubble-text">${escapeHtml(active.text || "正在思考……")}<span class="stream-caret" aria-hidden="true"></span></div></article></section>`);
  }
  if (active.uploading) {
    blocks.push(`<section class="conversation-section active-section"><div class="section-label"><span>QQ 文件发送</span><span class="running-label"><i></i>上传中</span></div><article class="bubble agent live"><div class="bubble-meta"><strong>老代</strong><span>群文件</span></div><div class="bubble-text">${escapeHtml(active.text || "QQ 正在上传文件……")}</div></article></section>`);
  }
  if ((data.lastError || active.error) && !active.running) {
    blocks.push('<section class="failure-state" role="status"><strong>本次回复没有完成</strong><span>待处理消息和通知订阅游标均未提交，可以安全重试。</span></section>');
  }
  if (!blocks.length) blocks.push('<div class="empty-state"><strong>这里暂时很安静</strong><span>新消息和实时 Agent 输出会直接出现在这里。</span></div>');
  replaceConversation(blocks.join(""), signature, false, item.key);
}

function sourceProgressLabel(status) {
  return ({ idle: "无待处理", collecting: "收集中", queued: "排队中", running: "整理中", sending: "QQ 发送中", paused: "已暂停", failed: "失败 · 可重试", complete: "已送达" })[status] || "状态未知";
}

function renderSourceProgress(data) {
  const progress = data.subscriberProgress || [];
  if (!progress.length) return '<section class="source-progress"><div class="section-label"><span>订阅处理进度</span></div><p>当前没有启用的订阅会话。</p></section>';
  const headline = data.pendingSubscriberCount
    ? `${data.pendingSubscriberCount} 个会话待完成 · ${data.retainedCount || 0} 条来源消息保留中`
    : "当前没有待发送消息";
  return `<section class="source-progress" aria-label="订阅处理进度"><div class="section-label"><span>订阅处理进度</span><span>${escapeHtml(headline)}</span></div><div class="source-progress-list">${progress.map((item) => {
    const name = item.targetName || (item.targetType === "private" ? `私聊 ${item.targetId}` : `群 ${item.targetId}`);
    const detail = item.lastError ? `错误：${item.lastError}`
      : item.pendingCount ? `${item.pendingCount} 条待处理${item.status === "collecting" && item.collectionDeadline ? ` · 预计 ${formatTime(item.collectionDeadline)}` : ""}`
      : item.lastCompletedAt ? `最近送达 ${formatTime(item.lastCompletedAt)}` : "暂无匹配消息";
    return `<div class="source-progress-row"><div class="source-progress-copy"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(item.targetType === "private" ? "私聊" : "群聊")} · ${escapeHtml(detail)}</span></div><span class="source-progress-status ${escapeHtml(item.status)}">${escapeHtml(sourceProgressLabel(item.status))}</span></div>`;
  }).join("")}</div></section>`;
}

function renderSubscriptions(item) {
  if (!item || item.kind === "source") return;
  const subscriptions = item.data.subscriptions || [];
  els.subscriptionCount.textContent = String(subscriptions.length);
  els.subscriptionList.innerHTML = subscriptions.length ? subscriptions.map((subscription) => {
    const pending = Number(subscription.state?.pendingCount || 0);
    const deadline = subscription.state?.collectionDeadline;
    const subscriptionError = subscription.state?.lastError || "";
    const mode = `自动处理 · 本轮最后一条消息后等待 ${subscription.collectionDelayMinutes} 分钟`;
    const intake = subscription.intakeMode === "ADMIN_ONLY"
      ? "群管触发 · 前 10 条 + 等待期全部消息"
      : "全部消息";
    const sourceProgress = state?.qq?.sourceGroups?.[subscription.sourceGroupId]?.subscriberProgress
      ?.find((candidate) => candidate.subscriptionId === subscription.id);
    const status = !subscription.enabled ? "已停用" : sourceProgress
      ? sourceProgressLabel(sourceProgress.status) : subscriptionError ? "失败 · 可重试" : pending ? `${pending} 条待处理` : "已启用";
    return `<article class="subscription-card"><div class="subscription-card-head"><strong>${escapeHtml(subscription.sourceGroupName || `QQ群 ${subscription.sourceGroupId}`)}</strong><span class="subscription-pill">${escapeHtml(status)}</span></div><p>${escapeHtml(mode)}<br>${escapeHtml(intake)}${deadline ? `<br>预计处理：${escapeHtml(formatTime(deadline))}` : ""}${subscriptionError ? `<br>错误：${escapeHtml(subscriptionError)}` : ""}</p><div class="subscription-card-actions"><button type="button" data-edit-subscription="${escapeHtml(subscription.id)}">编辑</button><button class="delete" type="button" data-delete-subscription="${escapeHtml(subscription.id)}">删除</button></div></article>`;
  }).join("") : '<p class="empty compact">当前会话还没有订阅通知群</p>';
  refreshSourceOptions(item, null);
}

function refreshSourceOptions(item, current) {
  const available = [...(state?.qq?.availableSourceGroups || [])];
  if (current && !available.some((source) => source.groupId === current.sourceGroupId)) available.push({ groupId: current.sourceGroupId, groupName: current.sourceGroupName });
  const subscribed = new Set((item?.data?.subscriptions || []).filter((sub) => sub.id !== current?.id).map((sub) => sub.sourceGroupId));
  const options = available.filter((source) => !subscribed.has(source.groupId));
  els.subscriptionSource.innerHTML = options.length
    ? options.map((source) => `<option value="${escapeHtml(source.groupId)}">${escapeHtml(source.groupName || `QQ群 ${source.groupId}`)} · ${escapeHtml(source.groupId)}</option>`).join("")
    : '<option value="">没有可添加的来源群</option>';
  if (current) els.subscriptionSource.value = current.sourceGroupId;
}

function openSubscriptionForm(subscription = null) {
  const item = allItems().find((candidate) => candidate.key === selectedKey);
  if (!item || item.kind === "source") return;
  refreshSourceOptions(item, subscription);
  els.subscriptionId.value = subscription?.id || "";
  els.subscriptionIntake.value = subscription?.intakeMode || "ADMIN_ONLY";
  els.subscriptionDelay.value = String(subscription?.collectionDelayMinutes || 10);
  els.subscriptionEnabled.checked = subscription?.enabled !== false;
  els.subscriptionForm.hidden = false;
  els.addSubscriptionButton.hidden = true;
  els.subscriptionDetails.open = true;
}

function closeSubscriptionForm() {
  els.subscriptionForm.hidden = true;
  els.addSubscriptionButton.hidden = false;
  els.subscriptionForm.reset();
  els.subscriptionId.value = "";
}

function replaceConversation(html, signature, forceBottom, key = "") {
  const switched = renderedKey !== key;
  const tracker = scrollTracker(key);
  const followLatest = forceBottom || (switched ? tracker.followLatest : isNearBottom());
  const savedTop = switched ? tracker.top : els.conversation.scrollTop;
  els.conversation.innerHTML = html;
  renderedKey = key;
  conversationSignature = signature;
  requestAnimationFrame(() => {
    if (followLatest) scrollToLatest(false);
    else {
      els.conversation.scrollTop = Math.min(savedTop, Math.max(0, els.conversation.scrollHeight - els.conversation.clientHeight));
      tracker.followLatest = false;
      tracker.hasNewContent = true;
      updateJumpButton();
    }
  });
}

function renderMessage(message, processing = false, source = false) {
  const media = [
    ...(message.images || []).map((image) => image.error ? "图片下载失败" : `图片 · ${formatBytes(image.size)}`),
    ...(message.attachments || []).map((attachment) => attachment.error ? `${attachment.name || "附件"} · 缓存失败` : `${attachment.name || "附件"} · ${attachment.localPath ? "已缓存" : "未缓存"}`)
  ];
  const attachments = media.length ? `<div class="attachment-row">${media.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</div>` : "";
  const sender = message.senderName || "群成员";
  const role = source ? ` · ${formatRole(message.senderRole)}` : "";
  const sourceState = message.retainedBySubscription
    ? `仍被 ${Number(message.pendingSubscriberCount || 0)} 个订阅会话引用 · 全部处理后清理`
    : "近期上下文缓冲 · 不等待发送";
  return `<article class="bubble user ${message.trust === "OWNER" && !source ? "owner" : "untrusted"} ${processing ? "processing" : ""}"><div class="bubble-meta"><strong>${escapeHtml(sender)}${escapeHtml(role)}</strong><span>${escapeHtml(message.displayTime || formatTime(message.timestamp))}</span></div><div class="bubble-text">${escapeHtml(message.text || "（无文字）")}</div>${attachments}<div class="message-state${source && !message.retainedBySubscription ? " resolved" : ""}">${source ? escapeHtml(sourceState) : processing ? "处理中 · 回复成功后移除" : "等待处理"}</div></article>`;
}

function renderReply(text) {
  return `<article class="bubble agent"><div class="bubble-meta"><strong>老代 · WorkBuddy</strong><span>已发送到 QQ</span></div><div class="bubble-text">${escapeHtml(text)}</div></article>`;
}

function getActiveReply(data) {
  return data?.activeReply || { running: false, status: "idle", text: "", error: null };
}

function formatThreadLock(lock) {
  return ({
    locked: "已由网关锁定",
    external_writer: "被其他写入端占用",
    error: "锁定失败 · 自动重试",
    checking: "检查中",
    unbound: "首次对话时创建"
  })[lock?.status] || "检查中";
}

function itemName(item) {
  if (item.kind === "private") return item.data.displayName || item.data.groupName || `QQ ${item.data.targetId}`;
  return item.data.groupName || `${item.kind === "source" ? "通知群" : "QQ群"} ${item.data.groupId || item.data.targetId}`;
}

function scrollTracker(key) {
  if (!scrollState.has(key)) scrollState.set(key, { top: 0, followLatest: true, hasNewContent: false });
  return scrollState.get(key);
}

function rememberCurrentScroll() {
  if (!renderedKey) return;
  const tracker = scrollTracker(renderedKey);
  tracker.top = els.conversation.scrollTop;
  tracker.followLatest = isNearBottom();
  if (tracker.followLatest) tracker.hasNewContent = false;
}

function isNearBottom() {
  return els.conversation.scrollHeight - els.conversation.scrollTop - els.conversation.clientHeight <= 72;
}

function scrollToLatest(smooth = true) {
  els.conversation.scrollTo({ top: els.conversation.scrollHeight, behavior: smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
  const tracker = scrollTracker(renderedKey);
  tracker.followLatest = true;
  tracker.hasNewContent = false;
  tracker.top = els.conversation.scrollHeight;
  updateJumpButton();
}

function updateJumpButton() {
  if (!renderedKey) {
    els.jumpToLatest.hidden = true;
    return;
  }
  const tracker = scrollTracker(renderedKey);
  els.jumpToLatest.hidden = tracker.followLatest && !tracker.hasNewContent;
}

function setConnection(text, tone) {
  els.connectionBadge.textContent = text;
  els.connectionBadge.className = `badge ${tone}`;
}

function connectStream() {
  if (!window.EventSource || stream) return;
  const token = localStorage.getItem("crc-hub-token") || "";
  const query = token ? `?access_token=${encodeURIComponent(token)}` : "";
  stream = new EventSource(`${HUB}/api/qq/stream${query}`);
  stream.onopen = () => setConnection("实时连接", "good");
  stream.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.state) {
      state = payload.state;
      render();
    } else scheduleRefresh();
  };
  stream.onerror = () => setConnection("实时连接重连中", "neutral");
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), 120);
}

function currentTarget() {
  const item = allItems().find((candidate) => candidate.key === selectedKey);
  return item && item.kind !== "source" ? item : null;
}

async function postTargetAction(action) {
  const item = currentTarget();
  if (!item) return;
  const segment = item.kind === "private" ? "private" : "groups";
  await api(`/api/qq/${segment}/${encodeURIComponent(item.data.targetId)}/${action}`, { method: "POST", body: "{}" });
  scheduleRefresh();
}

function selectTarget(key) {
  if (key === selectedKey) return;
  rememberCurrentScroll();
  selectedKey = key;
  conversationSignature = "";
  settingsSignature = "";
  settingsDirty = false;
  els.agentSettingsStatus.textContent = "";
  closeSubscriptionForm();
  localStorage.setItem("crc-selected-target", selectedKey);
  render();
}

els.refreshButton.addEventListener("click", refresh);
els.qzoneButton.addEventListener("click", () => { location.hash = "qzone"; });
els.closeQzoneButton.addEventListener("click", () => {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  renderView();
});
els.qzoneForm.addEventListener("change", () => { qzoneDirty = true; });
els.qzoneForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const [targetType, targetId] = els.qzoneTarget.value ? els.qzoneTarget.value.split(":") : [null, null];
  if (!targetId && (els.qzoneAutoPost.checked || els.qzoneAutoEngage.checked)) {
    els.qzoneSaveStatus.textContent = "请先选择绑定会话";
    return;
  }
  els.saveQzoneButton.disabled = true;
  els.qzoneSaveStatus.textContent = "正在保存…";
  try {
    const saved = await api("/api/qq/qzone/settings", { method: "POST", body: JSON.stringify({ targetType, targetId, autoPostEnabled: els.qzoneAutoPost.checked, autoEngageEnabled: els.qzoneAutoEngage.checked }) });
    state.qq.qzone = saved;
    qzoneDirty = false;
    els.qzoneSaveStatus.textContent = "已保存";
    renderQzone();
  } catch (error) {
    els.qzoneSaveStatus.textContent = error.message;
  } finally {
    els.saveQzoneButton.disabled = false;
  }
});
els.stickerGalleryButton.addEventListener("click", () => {
  location.hash = "stickers";
});
els.closeStickerGalleryButton.addEventListener("click", () => {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  renderView();
});
for (const [button, view] of [[els.stickerLibraryButton, "library"], [els.stickerBlacklistButton, "blacklist"]]) {
  button.addEventListener("click", () => {
    stickerGalleryView = view;
    stickerEditingId = "";
    stickerEditDraft = "";
    stickerGallerySignature = "";
    renderStickerGallery();
  });
}
els.stickerGalleryGrid.addEventListener("input", (event) => {
  const form = event.target.closest("[data-sticker-edit-form]");
  if (form && form.dataset.stickerEditForm === stickerEditingId && event.target.name === "usage") {
    stickerEditDraft = event.target.value;
  }
});
els.stickerGalleryGrid.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-sticker]");
  if (editButton && !stickerActionSavingId) {
    const id = editButton.dataset.editSticker;
    const item = state?.qq?.stickers?.items?.find((candidate) => candidate.id === id);
    if (!item) return;
    stickerEditingId = id;
    stickerEditDraft = item.usage || "";
    setStickerGalleryActionStatus("");
    stickerGallerySignature = "";
    renderStickerGallery();
    requestAnimationFrame(() => els.stickerGalleryGrid.querySelector(`[data-sticker-edit-form="${CSS.escape(id)}"] textarea`)?.focus());
    return;
  }
  if (event.target.closest("[data-cancel-sticker-edit]") && !stickerActionSavingId) {
    stickerEditingId = "";
    stickerEditDraft = "";
    setStickerGalleryActionStatus("");
    stickerGallerySignature = "";
    renderStickerGallery();
    return;
  }
  const deleteButton = event.target.closest("[data-delete-sticker]");
  const restoreButton = event.target.closest("[data-restore-sticker]");
  const forgetButton = event.target.closest("[data-forget-sticker]");
  if (!(deleteButton || restoreButton || forgetButton) || stickerActionSavingId) return;
  const id = deleteButton?.dataset.deleteSticker || restoreButton?.dataset.restoreSticker || forgetButton?.dataset.forgetSticker;
  const item = [...(state?.qq?.stickers?.items || []), ...(state?.qq?.stickers?.excludedItems || [])].find((candidate) => candidate.id === id);
  if (!item) return;
  const action = forgetButton ? "forget" : restoreButton ? "restore" : "blacklist";
  if (action === "forget" && !window.confirm(`彻底删除并忘记这个表情？\n\n${item.usage || item.id}\n\n将清除网关记录、所有去重指纹和表情库副本。下次收到会作为新表情重新识别。群消息原图和 QQ 客户端收藏不受影响。此操作不可撤销。`)) return;
  if (action === "blacklist" && !window.confirm(`将这个表情移入黑名单？\n\n${item.usage}\n\n保留预览和备注，以后收到也不识别、不入库。可在黑名单中恢复。群消息原图和 QQ 客户端收藏不受影响。`)) return;
  stickerActionSavingId = id;
  setStickerGalleryActionStatus(action === "forget" ? "正在彻底删除并忘记…" : action === "restore" ? "正在移出黑名单…" : "正在移入黑名单…", "progress");
  stickerGallerySignature = "";
  renderStickerGallery();
  try {
    const result = await api(`/api/qq/stickers/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
    state.qq.stickers = { ...result.stickers, labeling: state.qq.stickers?.labeling, curation: state.qq.stickers?.curation };
    if (stickerEditingId === id) {
      stickerEditingId = "";
      stickerEditDraft = "";
    }
    setStickerGalleryActionStatus(action === "forget" ? "已彻底忘记所有指纹；下次收到会重新识别入库。QQ 客户端收藏未改动。"
      : action === "restore" ? result.result?.restored ? "已恢复到表情库，老代可再次使用。" : "已解除黑名单；没有可恢复的完整副本，下次收到会重新识别。"
      : "已移入黑名单，预览和备注保留；以后不再自动收录，可随时恢复。", "success");
  } catch (error) {
    setStickerGalleryActionStatus(`操作失败：${error.message}`, "error");
  } finally {
    stickerActionSavingId = "";
    stickerGallerySignature = "";
    renderStickerGallery();
  }
});
els.stickerGalleryGrid.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-sticker-edit-form]");
  if (!form) return;
  event.preventDefault();
  const id = form.dataset.stickerEditForm;
  if (!id || stickerActionSavingId) return;
  stickerEditDraft = String(new FormData(form).get("usage") || "");
  stickerActionSavingId = id;
  setStickerGalleryActionStatus("正在保存备注…", "progress");
  stickerGallerySignature = "";
  renderStickerGallery();
  try {
    const result = await api(`/api/qq/stickers/${encodeURIComponent(id)}/update`, { method: "POST", body: JSON.stringify({ usage: stickerEditDraft }) });
    state.qq.stickers = { ...result.stickers, labeling: state.qq.stickers?.labeling, curation: state.qq.stickers?.curation };
    stickerEditingId = "";
    stickerEditDraft = "";
    setStickerGalleryActionStatus("备注已保存，Agent 会立即使用新描述。", "success");
  } catch (error) {
    setStickerGalleryActionStatus(`保存失败：${error.message}`, "error");
  } finally {
    stickerActionSavingId = "";
    stickerGallerySignature = "";
    renderStickerGallery();
  }
});
window.addEventListener("hashchange", renderView);
els.replyEnabledToggle.addEventListener("change", async () => {
  const item = currentTarget();
  if (!item || replySwitchSaving) return;
  const enabled = els.replyEnabledToggle.checked;
  replySwitchSaving = true;
  els.replyEnabledToggle.disabled = true;
  try {
    const segment = item.kind === "private" ? "private" : "groups";
    const saved = await api(`/api/qq/${segment}/${encodeURIComponent(item.data.targetId)}/reply-enabled`, { method: "POST", body: JSON.stringify({ enabled }) });
    item.data.replyEnabled = saved.replyEnabled;
    await refresh();
  } catch (error) {
    showError(error);
    scheduleRefresh();
  } finally {
    replySwitchSaving = false;
    render();
  }
});
els.agentDispatchToggle.addEventListener("change", async () => {
  const enabled = els.agentDispatchToggle.checked;
  els.agentDispatchToggle.disabled = true;
  try {
    const dispatch = await api("/api/qq/agent-dispatch", { method: "POST", body: JSON.stringify({ enabled }) });
    state.agentDispatch = dispatch;
    renderServices();
    scheduleRefresh();
  } catch (error) {
    els.agentDispatchToggle.checked = !enabled;
    showError(error);
  } finally {
    els.agentDispatchToggle.disabled = false;
  }
});
for (const list of [els.groupList, els.privateList, els.sourceList]) {
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-target-key]");
    if (button) selectTarget(button.dataset.targetKey);
  });
}
els.conversation.addEventListener("scroll", () => {
  if (!renderedKey) return;
  const tracker = scrollTracker(renderedKey);
  tracker.top = els.conversation.scrollTop;
  tracker.followLatest = isNearBottom();
  if (tracker.followLatest) tracker.hasNewContent = false;
  updateJumpButton();
}, { passive: true });
els.jumpToLatest.addEventListener("click", () => scrollToLatest(true));
els.sessionButton.addEventListener("click", () => postTargetAction("session").catch(showError));
els.retryButton.addEventListener("click", () => postTargetAction("retry").catch(showError));
els.resetButton.addEventListener("click", () => {
  const item = currentTarget();
  const warning = item?.kind === "group"
    ? "为当前群创建新的 WorkBuddy 会话？新会话初始化成功后，旧会话和本地历史将永久删除。"
    : "为当前私聊创建新的 WorkBuddy 会话？旧会话不会再自动使用。";
  if (!confirm(warning)) return;
  postTargetAction("reset").catch(showError);
});
els.cancelButton.addEventListener("click", async () => {
  const item = currentTarget();
  if (!item) return;
  try {
    await api("/api/qq/agent/cancel", { method: "POST", body: JSON.stringify({ targetType: item.kind, targetId: item.data.targetId }) });
    scheduleRefresh();
  } catch (error) {
    showError(error);
  }
});
els.agentModel.addEventListener("change", () => {
  populateEffortOptions(null);
  markSettingsDirty();
});
els.agentReasoningEffort.addEventListener("change", markSettingsDirty);
els.agentContextTokenLimit.addEventListener("change", markSettingsDirty);
els.agentWorkingMode.addEventListener("change", markSettingsDirty);
els.agentPermissionMode.addEventListener("change", markSettingsDirty);
els.agentCalendarRemindersEnabled.addEventListener("change", () => {
  updateParameterExplanation(currentTarget());
  markSettingsDirty();
});
els.agentSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const item = currentTarget();
  if (!item || item.data.busy || item.data.activeReply?.running) return;
  const enablingGroupFullAccess = item.kind === "group"
    && els.agentPermissionMode.value === "dangerFullAccess"
    && item.data.codexConfig?.permissionMode !== "dangerFullAccess";
  if (enablingGroupFullAccess && !window.confirm("开启完全访问后，当前群的所有成员都能通过老代操作整台 Mac，并发送本机任意位置的文件到本群。只读通知源不会获得该权限。确认开启吗？")) return;
  els.saveAgentSettingsButton.disabled = true;
  els.saveAgentSettingsButton.textContent = "保存中…";
  els.agentSettingsStatus.textContent = "正在保存";
  els.agentSettingsStatus.className = "form-status";
  try {
    const segment = item.kind === "private" ? "private" : "groups";
    const response = await api(`/api/qq/${segment}/${encodeURIComponent(item.data.targetId)}/config`, {
      method: "POST",
      body: JSON.stringify({
        model: els.agentModel.value,
        reasoningEffort: els.agentReasoningEffort.value,
        contextTokenLimit: els.agentContextTokenLimit.value === "auto" ? "auto" : Number(els.agentContextTokenLimit.value),
        workingMode: els.agentWorkingMode.value,
        permissionMode: els.agentPermissionMode.value,
        calendarRemindersEnabled: els.agentCalendarRemindersEnabled.checked
      })
    });
    item.data.codexConfig = response.codexConfig;
    settingsDirty = false;
    settingsSignature = "";
    els.agentSettingsStatus.textContent = "已保存，下轮生效；当前 thread 保持不变。";
    renderAgentSettings(item);
    scheduleRefresh();
  } catch (error) {
    els.agentSettingsStatus.textContent = error.message;
    els.agentSettingsStatus.className = "form-status error";
    settingsDirty = true;
  } finally {
    els.saveAgentSettingsButton.textContent = "保存会话参数";
    els.saveAgentSettingsButton.disabled = !settingsDirty;
  }
});
els.stickerLabelModel.addEventListener("change", () => {
  stickerLabelDirty = true;
  els.stickerLabelStatus.textContent = "有未保存的修改";
  els.stickerLabelStatus.className = "form-status";
  renderStickerLabelSettings();
});
els.stickerLabelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!stickerLabelDirty) return;
  els.saveStickerLabelButton.disabled = true;
  els.saveStickerLabelButton.textContent = "保存中…";
  els.stickerLabelStatus.textContent = "正在保存";
  els.stickerLabelStatus.className = "form-status";
  try {
    const response = await api("/api/qq/stickers/label-settings", {
      method: "POST",
      body: JSON.stringify({ model: els.stickerLabelModel.value })
    });
    state.qq.stickers.labeling = response;
    stickerLabelDirty = false;
    stickerLabelSignature = "";
    els.stickerLabelStatus.textContent = "已保存；从下一批新表情开始使用。";
    renderStickerLabelSettings();
    scheduleRefresh();
  } catch (error) {
    els.stickerLabelStatus.textContent = error.message;
    els.stickerLabelStatus.className = "form-status error";
    stickerLabelDirty = true;
  } finally {
    els.saveStickerLabelButton.textContent = "保存识图模型";
    els.saveStickerLabelButton.disabled = !stickerLabelDirty;
  }
});
els.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const item = currentTarget();
  const text = els.promptInput.value.trim();
  if (!text || !item) return;
  els.sendButton.disabled = true;
  try {
    await api("/api/qq/agent-message", { method: "POST", body: JSON.stringify({ targetType: item.kind, targetId: item.data.targetId, text }) });
    els.promptInput.value = "";
    scheduleRefresh();
  } catch (error) {
    showError(error);
  } finally {
    els.sendButton.disabled = !currentTarget();
  }
});

async function loadGroupCandidates() {
  if (groupCandidatesLoading) return;
  groupCandidatesLoading = true;
  els.groupCandidate.disabled = true;
  els.saveGroupButton.disabled = true;
  els.reloadGroupCandidatesButton.disabled = true;
  els.groupCandidate.innerHTML = '<option value="">正在读取群列表…</option>';
  els.groupFormStatus.textContent = "正在读取机器人已加入的群…";
  els.groupFormStatus.className = "form-status";
  try {
    const result = await api("/api/qq/groups/available");
    const groups = result.groups || [];
    els.groupCandidate.innerHTML = groups.length
      ? '<option value="">请选择 QQ 群</option>' + groups.map((group) => `<option value="${escapeHtml(group.groupId)}">${escapeHtml(group.groupName || "未命名群")} · ${escapeHtml(group.groupId)}</option>`).join("")
      : '<option value="">没有可加入的群</option>';
    els.groupCandidate.disabled = !groups.length;
    els.saveGroupButton.disabled = true;
    els.groupFormStatus.textContent = groups.length ? `可选择 ${groups.length} 个群；加入后立即生效。` : "机器人已加入的群都已管理，或被设为只读通知源。";
    els.groupFormStatus.className = "form-status";
  } catch (error) {
    els.groupCandidate.innerHTML = '<option value="">读取失败</option>';
    els.groupFormStatus.textContent = error.message;
    els.groupFormStatus.className = "form-status error";
  } finally {
    groupCandidatesLoading = false;
    els.reloadGroupCandidatesButton.disabled = false;
  }
}

function closeGroupForm() {
  els.groupForm.hidden = true;
  els.addGroupButton.hidden = false;
  els.groupForm.reset();
  els.groupFormStatus.textContent = "";
  els.groupFormStatus.className = "form-status";
}

els.addGroupButton.addEventListener("click", () => {
  els.groupForm.hidden = false;
  els.addGroupButton.hidden = true;
  loadGroupCandidates().catch(showError);
});
els.reloadGroupCandidatesButton.addEventListener("click", () => loadGroupCandidates().catch(showError));
els.groupCandidate.addEventListener("change", () => { els.saveGroupButton.disabled = !els.groupCandidate.value; });
els.cancelGroupButton.addEventListener("click", closeGroupForm);
els.groupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const groupId = els.groupCandidate.value;
  if (!groupId || groupCandidatesLoading) return;
  els.saveGroupButton.disabled = true;
  els.groupFormStatus.textContent = "正在加入白名单…";
  els.groupFormStatus.className = "form-status";
  try {
    await api("/api/qq/groups", { method: "POST", body: JSON.stringify({ groupId }) });
    closeGroupForm();
    selectedKey = `group:${groupId}`;
    await refresh();
  } catch (error) {
    els.groupFormStatus.textContent = error.message;
    els.groupFormStatus.className = "form-status error";
    els.saveGroupButton.disabled = false;
  }
});

els.addPrivateButton.addEventListener("click", () => {
  els.privateForm.hidden = false;
  els.addPrivateButton.hidden = true;
  els.privateFormStatus.textContent = "";
  els.privateFormStatus.className = "form-status";
  els.privateUserId.focus();
});
els.cancelPrivateButton.addEventListener("click", () => {
  els.privateForm.hidden = true;
  els.addPrivateButton.hidden = false;
  els.privateForm.reset();
  els.privateFormStatus.textContent = "";
  els.privateFormStatus.className = "form-status";
});
els.privateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.savePrivateButton.disabled = true;
  els.privateFormStatus.textContent = "正在加入白名单…";
  els.privateFormStatus.className = "form-status";
  try {
    const userId = els.privateUserId.value.trim();
    await api("/api/qq/private-chats", { method: "POST", body: JSON.stringify({ userId, displayName: els.privateDisplayName.value.trim() }) });
    els.privateForm.hidden = true;
    els.addPrivateButton.hidden = false;
    els.privateForm.reset();
    selectedKey = `private:${userId}`;
    await refresh();
  } catch (error) {
    els.privateFormStatus.textContent = error.message;
    els.privateFormStatus.className = "form-status error";
  } finally {
    els.savePrivateButton.disabled = false;
  }
});

els.addSubscriptionButton.addEventListener("click", () => openSubscriptionForm());
els.cancelSubscriptionButton.addEventListener("click", closeSubscriptionForm);
els.subscriptionList.addEventListener("click", async (event) => {
  const item = currentTarget();
  if (!item) return;
  const edit = event.target.closest("[data-edit-subscription]");
  if (edit) {
    const subscription = (item.data.subscriptions || []).find((candidate) => candidate.id === edit.dataset.editSubscription);
    if (subscription) openSubscriptionForm(subscription);
    return;
  }
  const remove = event.target.closest("[data-delete-subscription]");
  if (!remove || !confirm("删除这条订阅？该目标尚未消费的来源消息也会被释放；其他目标的订阅不受影响。")) return;
  try {
    await api(`/api/qq/subscriptions/${encodeURIComponent(remove.dataset.deleteSubscription)}/delete`, { method: "POST", body: "{}" });
    closeSubscriptionForm();
    scheduleRefresh();
  } catch (error) {
    showError(error);
  }
});
els.subscriptionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const item = currentTarget();
  if (!item) return;
  try {
    await api("/api/qq/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        id: els.subscriptionId.value || undefined,
        targetType: item.kind,
        targetId: item.data.targetId,
        sourceGroupId: els.subscriptionSource.value,
        mode: "AUTO",
        intakeMode: els.subscriptionIntake.value,
        collectionDelayMinutes: Number(els.subscriptionDelay.value || 10),
        enabled: els.subscriptionEnabled.checked
      })
    });
    closeSubscriptionForm();
    scheduleRefresh();
  } catch (error) {
    showError(error);
  }
});

function showError(error) {
  els.groupError.hidden = false;
  els.groupError.textContent = error.message;
}

function setStickerGalleryActionStatus(message, tone = "") {
  els.stickerGalleryActionStatus.textContent = message;
  els.stickerGalleryActionStatus.className = `gallery-action-status ${tone}`.trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function formatTrigger(value) {
  return ({ mention: "被 @ / 私聊触发", followup: "新消息接话", message_count: "消息数量触发", scheduled: "定时触发", subscription_auto: "自动通知订阅", retry: "重试", control: "控制指令" })[value] || "—";
}

function formatRole(value) {
  return ({ owner: "群主", admin: "管理员", member: "成员" })[value] || "成员";
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function effortLabel(value) {
  return ({ auto: "自动", none: "无", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最大", ultra: "极致" })[value] || String(value || "默认");
}

function formatTokenLimit(value) {
  if (value === "auto") return "自动";
  const tokens = Number(value || 0);
  if (!tokens) return "默认";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

function workModeLabel(value) {
  return ({ agent: "Agent", plan: "Plan", ask: "Ask" })[value] || "Agent";
}

function permissionModeLabel(value) {
  return ({ readOnly: "只读", workspaceWrite: "工作区", dangerFullAccess: "完全访问" })[value] || "工作区";
}

await refresh();
connectStream();
