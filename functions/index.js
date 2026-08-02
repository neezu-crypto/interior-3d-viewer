const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase, ServerValue } = require('firebase-admin/database');
const crypto = require('crypto');

initializeApp();

const MAX_NAME_LEN = 40;
const MAX_CONFIG_JSON_LEN = 20000;
const ALLOWED_CONFIG_KEYS = [
  'wallStyleId', 'moldingStyleId', 'floorStyleId',
  'furnitureState', 'furniturePositions', 'furnitureRotations',
  'zoomLevel', 'adjust', 'timeOfDay',
  'sceneUrl' // 방 설정이 아니라 완전히 다른 배경 페이지(스키장 등)로 연결되는 프리셋용
];

// sceneUrl은 임의 외부 주소로 리다이렉트되지 않도록 "같은 폴더의 html 파일명" 형태만 허용
function assertSafeSceneUrl(config) {
  if ('sceneUrl' in config) {
    if (typeof config.sceneUrl !== 'string' || !/^[a-zA-Z0-9_-]+\.html$/.test(config.sceneUrl)) {
      throw new HttpsError('invalid-argument', 'sceneUrl은 같은 폴더의 html 파일명만 허용됩니다.');
    }
  }
}
const MERGE_TICKET_TTL_MS = 10 * 60 * 1000;
const ADMIN_EMAIL = 'skftodwocks2@gmail.com';

// uid 위변조 검증 원칙 - 프리셋 소유자 uid는 클라이언트가 보낸 값을 절대 신뢰하지 않고
// 항상 request.auth.uid에서만 가져온다 (StreamBet-Market functions/src/lib/auth.js와 동일 원칙).
function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  return request.auth.uid;
}

// 익명 계정도 프리셋 게시는 그대로 허용하지만(기기별 영속 uid로 소유권은 확인됨),
// 추후 유료 프리셋 판매 등 재화가 걸리는 기능은 이 값으로 실계정만 허용하도록 확장한다.
function isRealAccount(request) {
  const provider = request.auth && request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  return provider !== 'anonymous';
}

// 09번 마이그레이션 — 관리자 판별을 이메일 문자열 비교에서 공유
// adminCenter/adminUids uid 조회로 옮긴다(StreamBet-Market·soop-stock-market·
// admin-center와 동일 전환 방식). uid 미등록 시에만 이메일로 폴백하고,
// 폴백이 쓰이면 로그를 남긴다.
async function isAdminUid(uid) {
  const db = getDatabase();
  const snap = await db.ref('adminCenter/adminUids/' + uid).get();
  return snap.val() === true;
}

// 공개 갤러리는 지금은 관리자가 큐레이션하는 공식 프리셋 목록 - 게시/수정/삭제는 관리자만
// 가능하고, 일반 사용자(익명 포함)는 읽기(적용)만 할 수 있다. email 클레임은 익명 계정엔
// 아예 없으므로 이 체크는 자연히 실계정(Google) 로그인 + 그 이메일 일치를 함께 요구한다.
async function requireAdmin(request) {
  const uid = requireAuth(request);
  if (await isAdminUid(uid)) return uid;
  const email = request.auth.token && request.auth.token.email;
  if (email === ADMIN_EMAIL) {
    console.warn('관리자 판별 이메일 폴백 사용됨(uid 미등록):', uid);
    return uid;
  }
  throw new HttpsError('permission-denied', '관리자만 수행할 수 있습니다.');
}

// interior-3d-viewer 프리셋 갤러리 전용 함수. presetgallery 코드베이스로 분리되어 있어서
// 이 프로젝트의 다른 서비스(default 코드베이스) 함수들과는 완전히 독립적으로 배포/관리됨.
exports.publishPreset = onCall({ region: 'us-central1' }, async (request) => {
  const uid = await requireAdmin(request);
  const data = request.data || {};
  const rawName = data.name;
  const rawConfig = data.config;

  if (typeof rawName !== 'string' || !rawName.trim()) {
    throw new HttpsError('invalid-argument', '프리셋 이름이 필요합니다.');
  }
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new HttpsError('invalid-argument', '설정 데이터가 올바르지 않습니다.');
  }

  const name = rawName.trim().slice(0, MAX_NAME_LEN);

  // 예상된 필드만 복사해서 저장 (악의적이거나 예상치 못한 필드 주입 방지)
  const config = {};
  ALLOWED_CONFIG_KEYS.forEach(function (key) {
    if (key in rawConfig) config[key] = rawConfig[key];
  });
  assertSafeSceneUrl(config);

  if (JSON.stringify(config).length > MAX_CONFIG_JSON_LEN) {
    throw new HttpsError('invalid-argument', '설정 데이터가 너무 큽니다.');
  }

  const db = getDatabase();
  const newRef = db.ref('presetGallery').push();
  await newRef.set({
    name: name,
    config: config,
    ownerUid: uid,
    ownerIsRealAccount: isRealAccount(request),
    createdAt: Date.now()
  });

  return { id: newRef.key };
});

// 이미 게시된 프리셋의 이름/설정을 그대로 덮어쓴다 (관리자 전용) - id/게시자/게시일은 유지하고
// config(및 선택적으로 name)만 교체, updatedAt만 새로 기록한다.
exports.updatePreset = onCall({ region: 'us-central1' }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  const id = data.id;
  const rawName = data.name;
  const rawConfig = data.config;

  if (typeof id !== 'string' || !id) {
    throw new HttpsError('invalid-argument', '수정할 프리셋 id가 필요합니다.');
  }
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new HttpsError('invalid-argument', '설정 데이터가 올바르지 않습니다.');
  }

  const db = getDatabase();
  const nodeRef = db.ref('presetGallery/' + id);
  const snap = await nodeRef.get();
  if (!snap.exists()) {
    throw new HttpsError('not-found', '존재하지 않는 프리셋입니다.');
  }

  const config = {};
  ALLOWED_CONFIG_KEYS.forEach(function (key) {
    if (key in rawConfig) config[key] = rawConfig[key];
  });
  assertSafeSceneUrl(config);
  if (JSON.stringify(config).length > MAX_CONFIG_JSON_LEN) {
    throw new HttpsError('invalid-argument', '설정 데이터가 너무 큽니다.');
  }

  const updates = { config: config, updatedAt: Date.now() };
  if (typeof rawName === 'string' && rawName.trim()) {
    updates.name = rawName.trim().slice(0, MAX_NAME_LEN);
  }

  await nodeRef.update(updates);
  return { ok: true };
});

// 게시가 관리자 전용으로 바뀌었으므로 삭제도 소유자(ownerUid) 대신 관리자 여부로만 판별한다.
exports.deletePreset = onCall({ region: 'us-central1' }, async (request) => {
  await requireAdmin(request);
  const id = request.data && request.data.id;
  if (typeof id !== 'string' || !id) {
    throw new HttpsError('invalid-argument', '삭제할 프리셋 id가 필요합니다.');
  }

  const db = getDatabase();
  const nodeRef = db.ref('presetGallery/' + id);
  const snap = await nodeRef.get();
  if (!snap.exists()) {
    throw new HttpsError('not-found', '이미 삭제된 프리셋입니다.');
  }

  await nodeRef.remove();
  return { ok: true };
});

// 익명 계정으로 Google 로그인을 시도했는데 그 Google 계정이 이미 다른 uid로 가입돼 있는 경우
// (linkWithPopup이 auth/credential-already-in-use로 실패하는 경우), 클라이언트는 결국
// signInWithCredential로 그 "기존" 계정으로 전환하게 된다 - uid가 바뀌므로 그 사이 익명 uid로
// 게시했던 프리셋의 ownerUid를 새 uid로 옮겨줘야 소유권을 잃지 않는다.
//
// 이때 "옮길 대상 uid(oldUid)"를 클라이언트가 임의로 보낸 값으로 신뢰하면 안 된다 - presetGallery는
// 공개 읽기라 ownerUid가 누구에게나 보이므로, 그걸 그대로 신뢰하면 제3자가 "내가 이 익명 uid였다"고
// 거짓 주장해서 남의 프리셋 소유권을 가로챌 수 있다. 그래서 실제로 그 익명 uid로 인증된 시점(=
// requireAuth로 검증 가능한 유일한 시점)에 미리 발급한 1회용 티켓으로만 대상 uid를 확인한다.
exports.requestPresetMergeTicket = onCall({ region: 'us-central1' }, async (request) => {
  const uid = requireAuth(request);
  const db = getDatabase();
  const ticket = crypto.randomBytes(24).toString('hex');
  await db.ref('presetMergeTickets/' + ticket).set({ uid: uid, createdAt: Date.now() });
  return { ticket: ticket };
});

// 소유권 이전이 자동으로 안 끝난 경우(티켓 만료/분실, 갱신 도중 오류 등) 관리자가 나중에
// 터미널(firebase database:get/update)로 수동 처리할 수 있도록 남기는 감사 로그.
// Cloud Functions 로그(console.error, firebase functions:log로 조회)와 RTDB
// presetMergeFailures 노드(firebase database:get으로 직접 조회) 두 곳에 남긴다.
async function logMergeFailure(db, info) {
  console.error('[presetMerge] 자동 이전 실패 - 관리자 수동 확인 필요:', JSON.stringify(info));
  try {
    await db.ref('presetMergeFailures').push({
      oldUid: info.oldUid || null,
      newUid: info.newUid || null,
      ticket: info.ticket || null,
      reason: info.reason,
      detail: info.detail || null,
      verified: !!info.verified, // 유효한 티켓으로 확인된 oldUid인지 여부. false면 클라이언트 자체 신고(미검증) - 수동 이전 전 반드시 별도 확인 필요
      createdAt: Date.now()
    });
  } catch (logErr) {
    console.error('[presetMerge] 실패 로그 기록 자체가 실패함:', logErr);
  }
}

exports.claimPresetMerge = onCall({ region: 'us-central1' }, async (request) => {
  const newUid = requireAuth(request);
  const ticket = request.data && request.data.ticket;
  if (typeof ticket !== 'string' || !ticket) {
    throw new HttpsError('invalid-argument', '병합 티켓이 필요합니다.');
  }

  const db = getDatabase();
  const ticketRef = db.ref('presetMergeTickets/' + ticket);
  const ticketSnap = await ticketRef.get();
  if (!ticketSnap.exists()) {
    await logMergeFailure(db, { newUid: newUid, ticket: ticket, reason: 'ticket-not-found', verified: false });
    throw new HttpsError('not-found', '유효하지 않거나 이미 사용된 티켓입니다.');
  }
  const ticketData = ticketSnap.val();
  await ticketRef.remove(); // 1회용 - 결과와 무관하게 즉시 폐기해서 재사용을 막는다

  if (Date.now() - (ticketData.createdAt || 0) > MERGE_TICKET_TTL_MS) {
    await logMergeFailure(db, { oldUid: ticketData.uid, newUid: newUid, ticket: ticket, reason: 'ticket-expired', verified: true });
    throw new HttpsError('deadline-exceeded', '티켓이 만료되었습니다. 다시 로그인해 주세요.');
  }

  const oldUid = ticketData.uid;
  if (!oldUid || oldUid === newUid) {
    return { migrated: 0 };
  }

  try {
    const gallerySnap = await db.ref('presetGallery').orderByChild('ownerUid').equalTo(oldUid).get();
    const updates = {};
    gallerySnap.forEach(function (child) {
      updates[child.key + '/ownerUid'] = newUid;
    });
    if (Object.keys(updates).length > 0) {
      await db.ref('presetGallery').update(updates);
    }
    return { migrated: Object.keys(updates).length };
  } catch (err) {
    // 티켓은 이미 폐기됐으므로 클라이언트가 재시도해도 다시 성공할 수 없다 - 반드시 로그로 남겨야
    // 관리자가 presetGallery에서 ownerUid === oldUid인 항목을 찾아 newUid로 수동 이전할 수 있다.
    await logMergeFailure(db, { oldUid: oldUid, newUid: newUid, ticket: ticket, reason: 'update-failed', detail: String(err && err.message || err), verified: true });
    throw new HttpsError('internal', '소유권 이전 중 오류가 발생했습니다. 관리자에게 문의해 주세요.');
  }
});

// 티켓 발급(requestPresetMergeTicket) 자체가 실패해 claimPresetMerge를 호출할 수 없었던 경우를
// 위한 최후의 기록용 엔드포인트 - 클라이언트가 보낸 oldUidHint는 티켓으로 검증된 값이 아니므로
// (verified:false) 관리자가 실제로 그 uid가 맞는지 확인 후 수동으로 이전해야 한다.
exports.reportPresetMergeFailure = onCall({ region: 'us-central1' }, async (request) => {
  const newUid = requireAuth(request);
  const data = request.data || {};
  const oldUidHint = typeof data.oldUidHint === 'string' ? data.oldUidHint.slice(0, 128) : null;
  const reason = typeof data.reason === 'string' ? data.reason.slice(0, 64) : 'client-reported';

  const db = getDatabase();
  await logMergeFailure(db, { oldUid: oldUidHint, newUid: newUid, reason: reason, verified: false });
  return { ok: true };
});

// 09번/13번 — 클라이언트가 로컬에서 이메일 문자열을 직접 비교하던 관리자 UI
// 판별을 서버 확인으로 옮기기 위한 가벼운 전용 함수. adminCenter/adminUids는
// .read:false라 클라이언트가 직접 읽을 수 없으므로, 판별 결과만 반환한다.
// 이름을 galleryWhoAmI로 지은 이유 — StreamBet-Market·soop-stock-market도 같은
// 프로젝트에 같은 목적의 함수를 배포했다. codebase가 달라도 실제 Cloud Functions
// 이름공간은 프로젝트 전체에서 공유되므로, 이름이 겹치면 나중에 배포한 쪽이
// 앞선 쪽을 조용히 덮어쓴다 - 실제로 겪은 문제라 이름을 구분해서 피한다.
exports.galleryWhoAmI = onCall({ region: 'us-central1' }, async (request) => {
  const uid = requireAuth(request);
  if (await isAdminUid(uid)) return { isAdmin: true };
  const email = request.auth.token && request.auth.token.email;
  return { isAdmin: email === ADMIN_EMAIL };
});

// 13번 — 프리셋 소유권 병합 실패 조회/해결. 지금까지 이 노드를 처리하는 방법은
// 관리자가 firebase database:get/update로 CLI에서 직접 만지는 것뿐이었다(이
// 시리즈에서 유일한 사각지대). 이 두 함수가 그 CLI 수작업을 대체한다.
exports.listPresetMergeFailures = onCall({ region: 'us-central1' }, async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const snap = await db.ref('presetMergeFailures').get();
  const data = snap.val() || {};
  const entries = Object.keys(data).map(function (id) {
    return Object.assign({ id: id }, data[id]);
  }).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  return { entries: entries };
});

// action: 'transfer'(oldUid의 프리셋 소유권을 newUid로 재이전 — claimPresetMerge와
// 동일한 로직) 또는 'dismiss'(잘못된 신고 등으로 판단해 그냥 로그만 제거).
exports.resolvePresetMergeFailure = onCall({ region: 'us-central1' }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  const entryId = data.entryId;
  const action = data.action;
  if (!entryId) throw new HttpsError('invalid-argument', 'entryId가 필요합니다.');
  if (action !== 'transfer' && action !== 'dismiss') {
    throw new HttpsError('invalid-argument', 'action은 transfer 또는 dismiss여야 합니다.');
  }

  const db = getDatabase();
  const entrySnap = await db.ref('presetMergeFailures/' + entryId).get();
  if (!entrySnap.exists()) throw new HttpsError('not-found', '이미 처리됐거나 존재하지 않는 항목입니다.');
  const entry = entrySnap.val();

  if (action === 'dismiss') {
    await db.ref('presetMergeFailures/' + entryId).remove();
    return { ok: true, migrated: 0 };
  }

  const oldUid = entry.oldUid;
  const newUid = entry.newUid;
  if (!oldUid || !newUid) {
    throw new HttpsError('failed-precondition', '이전할 uid 정보가 부족합니다(oldUid/newUid 확인 필요) — dismiss로 처리하거나 수동으로 확인해 주세요.');
  }

  const gallerySnap = await db.ref('presetGallery').orderByChild('ownerUid').equalTo(oldUid).get();
  const updates = {};
  gallerySnap.forEach(function (child) { updates[child.key + '/ownerUid'] = newUid; });
  updates['presetMergeFailures/' + entryId] = null;
  await db.ref().update(updates);
  return { ok: true, migrated: Object.keys(updates).length - 1 };
});

// 배경시장 갤러리 통계 — 공개 갤러리 프리셋별 "적용"/"OBS 링크 복사" 클릭 횟수를
// 집계한다. 결제·소유권과 무관한 단순 사용량 카운터라 로그인한 누구나(익명 포함)
// 호출 가능하고, presetGallery/{id}/stats에 얹는다 - updatePreset은 .update()로
// config/name/updatedAt만 건드리므로 이 stats 필드는 수정·게시로 지워지지 않는다
// (deletePreset으로 프리셋 자체가 삭제될 때만 함께 사라짐, 이건 의도된 동작).
function assertPresetExists(db, presetId) {
  if (typeof presetId !== 'string' || !presetId) {
    throw new HttpsError('invalid-argument', 'presetId가 필요합니다.');
  }
  return db.ref('presetGallery/' + presetId).get().then(function (snap) {
    if (!snap.exists()) throw new HttpsError('not-found', '존재하지 않는 프리셋입니다.');
  });
}

exports.incrementPresetApplyCount = onCall({ region: 'us-central1' }, async (request) => {
  requireAuth(request);
  const presetId = request.data && request.data.presetId;
  const db = getDatabase();
  await assertPresetExists(db, presetId);
  await db.ref('presetGallery/' + presetId + '/stats/applyCount').set(ServerValue.increment(1));
  return { ok: true };
});

exports.incrementPresetObsLinkCount = onCall({ region: 'us-central1' }, async (request) => {
  requireAuth(request);
  const presetId = request.data && request.data.presetId;
  const db = getDatabase();
  await assertPresetExists(db, presetId);
  await db.ref('presetGallery/' + presetId + '/stats/obsLinkCount').set(ServerValue.increment(1));
  return { ok: true };
});
