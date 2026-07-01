'use strict';
// 배민 리뷰(self-api.baemin.com/v1/review/.../reviews) → 노심 v4 /api/reviews/ingest 아이템 매핑.
// 순수 함수(네트워크·전자 무관) — 단위 테스트 대상. 2026-07-02 실측 스키마 기반.
// 실측 리뷰 필드: id·shopNumber·memberNo·memberNickname·rating·contents·displayStatus·
//   comments(사장님 답글)·images·menus·deliveryReviews·createdDate·createdAt·orderCount·blockType 등.

/** 작성자 닉네임 마스킹 — 앞 1글자 + ****. PII 최소화(원문 닉네임 미전송). */
function maskNickname(nick) {
  const s = String(nick == null ? '' : nick).trim();
  if (!s) return null;
  return s.slice(0, 1) + '****';
}

/** 다양한 날짜 표현(ISO·epoch(초/밀리초)·'YYYY.MM.DD'·'YYYY-MM-DD')을 ISO(UTC 'Z')로. 실패=null. */
function toIso(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const ms = v < 1e12 ? v * 1000 : v; // 초 vs 밀리초
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  let s = String(v).trim();
  if (/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '-'); // 2026.7.1 → 2026-7-1
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** menus/ images 처럼 문자열 or {키} 배열을 문자열 배열로. */
function toStringList(arr, keys) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (it == null) continue;
    if (typeof it === 'string') { if (it.trim()) out.push(it.trim()); continue; }
    if (typeof it === 'object') {
      for (const k of keys) { if (typeof it[k] === 'string' && it[k].trim()) { out.push(it[k].trim()); break; } }
    }
  }
  return out;
}

/** 사장님(가게) 답글 존재/내용 — comments 배열에서 추출. v4 Review.ownerReplied 지원 시 사용(현재 스키마 미보유→ingest가 무시, 후속). */
function ownerReplyOf(raw) {
  const c = raw.comments;
  if (!Array.isArray(c) || c.length === 0) return { ownerReplied: false, ownerReplyBody: null };
  const first = c[0] || {};
  const body = first.contents || first.comment || first.content || null;
  return { ownerReplied: true, ownerReplyBody: typeof body === 'string' ? body : null };
}

/** displayStatus/blockType → 사장님에게만 보이는(블라인드/차단) 리뷰 여부(보수적). */
function isOwnerOnly(raw) {
  const st = String(raw.displayStatus || '').toUpperCase();
  const bt = String(raw.blockType || '').toUpperCase();
  if (bt && bt !== 'NONE' && bt !== 'NORMAL') return true;
  if (st.includes('BLIND') || st.includes('BLOCK') || st.includes('OWNER') || st.includes('HIDDEN')) return true;
  return false;
}

/**
 * 배민 리뷰 1건 → v4 ingest 아이템.
 * @param raw 배민 리뷰 객체
 * @param opts.platformStoreId 플랫폼 매장 식별자(=shopNumber 문자열)
 */
function mapBaeminReview(raw, opts) {
  if (!raw || raw.id == null) return null;
  const platformStoreId = String(opts && opts.platformStoreId != null ? opts.platformStoreId : (raw.shopNumber != null ? raw.shopNumber : ''));
  if (!platformStoreId) return null;

  const contents = typeof raw.contents === 'string' ? raw.contents.trim() : '';
  const rating = Math.max(0, Math.min(5, Math.round(Number(raw.rating) || 0)));
  const reply = ownerReplyOf(raw);

  return {
    platform: 'baemin',
    platformStoreId,
    platformReviewId: String(raw.id),
    rating,
    body: contents || null,
    authorMasked: maskNickname(raw.memberNickname),
    orderMenus: toStringList(raw.menus, ['menu', 'menuName', 'name']),
    reorderCount: Math.max(0, Math.round(Number(raw.orderCount) || 0)),
    writtenAt: toIso(raw.createdAt) || toIso(raw.createdDate),
    imageUrls: toStringList(raw.images, ['url', 'imageUrl', 'src']),
    isOwnerOnly: isOwnerOnly(raw),
    // v4 스키마 미보유(후속): ownerReplied 는 ingest zod 가 현재 무시. Review.ownerReplied 추가 시 사용.
    _ownerReplied: reply.ownerReplied,
    _ownerReplyBody: reply.ownerReplyBody,
  };
}

/** 배민 응답 { next, reviews:[...] } → ingest 아이템 배열(+ next). */
function mapBaeminReviewPage(resp, opts) {
  const reviews = (resp && Array.isArray(resp.reviews)) ? resp.reviews : [];
  const items = reviews.map((r) => mapBaeminReview(r, opts)).filter(Boolean);
  return { items, next: !!(resp && resp.next) };
}

module.exports = { mapBaeminReview, mapBaeminReviewPage, maskNickname, toIso, toStringList };
