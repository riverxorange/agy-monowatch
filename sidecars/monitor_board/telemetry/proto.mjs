/**
 * @fileoverview Zero-allocation Protobuf wire decoders and prompt/payload cleaners
 * for Antigravity SQLite trajectories (`steps`, `gen_metadata`, `parent_references`,
 * `chapter_titles`, `ERROR_MESSAGE`, and `generate_image`).
 */

import { UTF8_DECODER, VALID_CONV_UUID_RE, scrubInterpuncts } from './utils.mjs';
import { enumToModelCode, placeholderToEnum } from './routing.mjs';

const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const VALID_RAW_SLUG_RE = /^[a-z][a-z0-9._-]{2,79}$/i;
const VALID_DISPLAY_MODEL_RE = /^[A-Za-z][A-Za-z0-9 ._()/-]{2,95}$/;
const QUOTA_ERROR_RE =
  /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit|spend[- ]cap|prepaid[- ](?:credits|balance)|AI credits(?:\s+balance)?/i;
const LEGACY_TOOL_IN_17_RE =
  /\b(?:write_to_file|view_file|grep_search|list_dir)\b[\s\S]{0,80}\{"(?:ArtifactMetadata|AbsolutePath|CodeContent|DirectoryPath|SearchPath)"/;
const ERROR_ANCHOR_RE =
  /(?:Your previous response\b|Model produced invalid output\b|model output error:|Guidance:\s*You are trying to correct|GAPI error\b|API error\b|Model unavailable\b|http2:\s*(?:client connection|timeout)\b|The requested model was not found\b|There was a network issue\b|The stream was interrupted\b|RESOURCE_EXHAUSTED\b|Quota exceeded\b)/i;
const SAFETY_FILTER_RE =
  /blocked by content safety filters|Prohibited Use policy|comply with content policies|complies with content policies|sensitive words that violate|safety filter/i;
const SERVER_INJECTION_RE =
  /Guidance:\s*You are trying to correct|Malformed function call|improperly formatted function call|model output error:|cannot both be empty|Model produced invalid output|The stream was interrupted|Please continue the task you were working on/i;
const UPSTREAM_RETRY_RE =
  /API error|GAPI error|Model unavailable|\bhttp2:\s*(?:client connection|timeout)|The requested model was not found|stream idle timeout|context deadline exceeded|network issue connecting|INTERNAL\s*\(code\s*500\)|:\s*EOF\b|read tcp/i;

export function readVarint(buf, pos) {
  let val = 0;
  let factor = 1;
  const len = buf.length;
  while (pos < len) {
    const b = buf[pos++];
    val += (b & 0x7f) * factor;
    if ((b & 0x80) === 0) {
      return [val, pos];
    }
    factor *= 128;
    if (factor > 9_007_199_254_740_992) {
      while (pos < len && (buf[pos++] & 0x80) !== 0) {
        // advance past remaining int64 sign-extension bytes
      }
      return [val, pos];
    }
  }
  return null;
}

export function skipField(buf, pos, wireType) {
  if (wireType === 0) {
    const r = readVarint(buf, pos);
    return r ? r[1] : -1;
  }
  if (wireType === 1) {
    return pos + 8 <= buf.length ? pos + 8 : -1;
  }
  if (wireType === 2) {
    const r = readVarint(buf, pos);
    if (!r) return -1;
    const [len, nextPos] = r;
    return nextPos + len <= buf.length ? nextPos + len : -1;
  }
  if (wireType === 5) {
    return pos + 4 <= buf.length ? pos + 4 : -1;
  }
  return -1;
}

export function parseProtoTimestamp(buf, start, end) {
  let pos = start;
  let sec = 0;
  let nanos = 0;
  while (pos < end) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, p1] = tagRes;
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (wireType === 0) {
      const vRes = readVarint(buf, p1);
      if (!vRes) break;
      if (fieldNum === 1) sec = vRes[0];
      else if (fieldNum === 2) nanos = vRes[0];
      pos = vRes[1];
    } else {
      pos = skipField(buf, p1, wireType);
      if (pos < 0) break;
    }
  }
  return sec > 1_000_000_000 ? sec + nanos / 1e9 : 0;
}

export function isAsciiPrintableRange(buf, start, end) {
  if (end <= start) return false;
  for (let i = start; i < end; i++) {
    const c = buf[i];
    if (c < 32 || c > 126) return false;
  }
  return true;
}

export function parseTokenBreakdownSubmessage(buf, start, end) {
  const byName = new Map();
  let totalTokens = 0;
  let pos = start;
  while (pos < end) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, p1] = tagRes;
    const fn = Math.floor(tag / 8);
    const wt = tag & 7;
    if (wt === 2 && fn === 1) {
      const lenRes = readVarint(buf, p1);
      if (!lenRes) break;
      const [gLen, gStart] = lenRes;
      const gEnd = gStart + gLen;
      if (gEnd > end) break;
      let gp = gStart;
      let name = '';
      let numTokens = 0;
      while (gp < gEnd) {
        const gt = readVarint(buf, gp);
        if (!gt) break;
        const gfn = Math.floor(gt[0] / 8);
        const gwt = gt[0] & 7;
        if (gfn === 1 && gwt === 2) {
          const gl = readVarint(buf, gt[1]);
          if (!gl || gl[1] + gl[0] > gEnd) break;
          if (gl[0] > 0 && gl[0] <= 96) {
            name = scrubInterpuncts(
              UTF8_DECODER.decode(buf.subarray(gl[1], gl[1] + gl[0]))
            ).trim();
          }
          gp = gl[1] + gl[0];
        } else if (gfn === 4 && gwt === 0) {
          const gv = readVarint(buf, gt[1]);
          if (!gv) break;
          numTokens = gv[0];
          gp = gv[1];
        } else {
          const nx = skipField(buf, gt[1], gwt);
          if (nx < 0 || nx > gEnd) break;
          gp = nx;
        }
      }
      if (name && numTokens > 0) {
        byName.set(name, (byName.get(name) || 0) + numTokens);
      }
      pos = gEnd;
    } else if (wt === 0 && fn === 2) {
      const vRes = readVarint(buf, p1);
      if (!vRes) break;
      totalTokens = vRes[0];
      pos = vRes[1];
    } else {
      const nx = skipField(buf, p1, wt);
      if (nx < 0 || nx > end) break;
      pos = nx;
    }
  }
  const groups = Array.from(byName.entries())
    .map(([name, tokens]) => ({ name, tokens }))
    .filter((g) => g.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  return { groups, totalTokens };
}

export function parseContextField9Submessage(buf, start, end) {
  if (end <= start) return null;
  let checkpointStepIndex = 0;
  let hasCheckpointField = false;
  let estimatedTokensUsed = 0;
  let truncationReason = 0;
  let maxContextTokens = 0;
  let breakdown = [];
  let hasField10 = false;
  let pos = start;

  while (pos < end) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) return null;
    const [tag, p1] = tagRes;
    const fn = Math.floor(tag / 8);
    const wt = tag & 7;
    if (fn <= 0 || fn > 32) return null;

    if (fn === 1 && wt === 0) {
      const vRes = readVarint(buf, p1);
      if (!vRes || vRes[1] > end) return null;
      checkpointStepIndex = vRes[0];
      hasCheckpointField = true;
      pos = vRes[1];
    } else if (fn === 10 && wt === 2) {
      const lenRes = readVarint(buf, p1);
      if (!lenRes) return null;
      const [cLen, cStart] = lenRes;
      const cEnd = cStart + cLen;
      if (cEnd > end) return null;
      hasField10 = true;
      let cp = cStart;
      while (cp < cEnd) {
        const ct = readVarint(buf, cp);
        if (!ct) return null;
        const cfn = Math.floor(ct[0] / 8);
        const cwt = ct[0] & 7;
        if (cfn <= 0 || cfn > 32) return null;
        if (cfn === 1 && cwt === 0) {
          const v = readVarint(buf, ct[1]);
          if (!v || v[1] > cEnd) return null;
          estimatedTokensUsed = v[0];
          cp = v[1];
        } else if (cfn === 2 && cwt === 0) {
          const v = readVarint(buf, ct[1]);
          if (!v || v[1] > cEnd) return null;
          truncationReason = v[0];
          cp = v[1];
        } else if (cfn === 3 && cwt === 2) {
          const bl = readVarint(buf, ct[1]);
          if (!bl || bl[1] + bl[0] > cEnd) return null;
          breakdown = parseTokenBreakdownSubmessage(
            buf,
            bl[1],
            bl[1] + bl[0]
          ).groups;
          cp = bl[1] + bl[0];
        } else if (cfn === 4 && cwt === 0) {
          const v = readVarint(buf, ct[1]);
          if (!v || v[1] > cEnd) return null;
          maxContextTokens = v[0];
          cp = v[1];
        } else {
          const nx = skipField(buf, ct[1], cwt);
          if (nx < 0 || nx > cEnd) return null;
          cp = nx;
        }
      }
      if (cp !== cEnd) return null;
      pos = cEnd;
    } else {
      const nx = skipField(buf, p1, wt);
      if (nx < 0 || nx > end) return null;
      pos = nx;
    }
  }

  if (pos !== end || !hasField10) return null;
  if (maxContextTokens <= 0 && estimatedTokensUsed <= 0 && breakdown.length === 0) {
    return null;
  }
  return {
    checkpointStepIndex,
    hasCheckpointField,
    estimatedTokensUsed,
    truncationReason,
    maxContextTokens,
    breakdown,
  };
}

export function extractContextField9FromRoot(fullBuf) {
  if (!fullBuf || fullBuf.length === 0) return null;
  let pos = 0;
  let found = null;
  while (pos < fullBuf.length) {
    const tagRes = readVarint(fullBuf, pos);
    if (!tagRes) break;
    const [tag, p1] = tagRes;
    const fn = Math.floor(tag / 8);
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      const lenRes = readVarint(fullBuf, p1);
      if (!lenRes) break;
      const [gLen, gStart] = lenRes;
      const gEnd = Math.min(fullBuf.length, gStart + gLen);
      let gp = gStart;
      while (gp < gEnd) {
        const gt = readVarint(fullBuf, gp);
        if (!gt) break;
        const gfn = Math.floor(gt[0] / 8);
        const gwt = gt[0] & 7;
        if (gfn === 9 && gwt === 2) {
          const fl = readVarint(fullBuf, gt[1]);
          if (fl && fl[1] + fl[0] <= gEnd) {
            const parsed = parseContextField9Submessage(
              fullBuf,
              fl[1],
              fl[1] + fl[0]
            );
            if (parsed) found = parsed;
          }
        }
        const nx = skipField(fullBuf, gt[1], gwt);
        if (nx < 0 || nx > gEnd) break;
        gp = nx;
      }
      pos = gStart + gLen;
      if (pos > fullBuf.length) break;
    } else {
      const nx = skipField(fullBuf, p1, wt);
      if (nx < 0 || nx > fullBuf.length) break;
      pos = nx;
    }
  }
  return found;
}

export function extractMaxWindowFromHead(headBuf) {
  if (!headBuf || headBuf.length === 0) return 0;
  let pos = 0;
  let maxWin = 0;
  while (pos < headBuf.length) {
    const tagRes = readVarint(headBuf, pos);
    if (!tagRes) break;
    const [tag, p1] = tagRes;
    const fn = Math.floor(tag / 8);
    const wt = tag & 7;
    if (fn === 3 && wt === 2) {
      const lenRes = readVarint(headBuf, p1);
      if (!lenRes) break;
      const [g3Len, g3Start] = lenRes;
      const g3End = Math.min(headBuf.length, g3Start + g3Len);
      let p3 = g3Start;
      while (p3 < g3End) {
        const t3 = readVarint(headBuf, p3);
        if (!t3) break;
        const fn3 = Math.floor(t3[0] / 8);
        const wt3 = t3[0] & 7;
        if (fn3 === 13 && wt3 === 2) {
          const l13 = readVarint(headBuf, t3[1]);
          if (!l13) break;
          const e13 = Math.min(g3End, l13[1] + l13[0]);
          let p13 = l13[1];
          while (p13 < e13) {
            const t13 = readVarint(headBuf, p13);
            if (!t13) break;
            const fn13 = Math.floor(t13[0] / 8);
            const wt13 = t13[0] & 7;
            if (fn13 === 2 && wt13 === 2) {
              const l2 = readVarint(headBuf, t13[1]);
              if (!l2) break;
              const e2 = Math.min(e13, l2[1] + l2[0]);
              let p2 = l2[1];
              while (p2 < e2) {
                const t2 = readVarint(headBuf, p2);
                if (!t2) break;
                const fn2 = Math.floor(t2[0] / 8);
                const wt2 = t2[0] & 7;
                if (fn2 === 22 && wt2 === 0) {
                  const v22 = readVarint(headBuf, t2[1]);
                  if (v22 && v22[0] >= 8192 && v22[0] <= 100_000_000) {
                    maxWin = v22[0];
                  }
                  p2 = v22 ? v22[1] : e2;
                } else {
                  const nx2 = skipField(headBuf, t2[1], wt2);
                  if (nx2 < 0 || nx2 > e2) break;
                  p2 = nx2;
                }
              }
              p13 = l2[1] + l2[0];
              if (p13 > e13) break;
            } else {
              const nx13 = skipField(headBuf, t13[1], wt13);
              if (nx13 < 0 || nx13 > e13) break;
              p13 = nx13;
            }
          }
          p3 = l13[1] + l13[0];
          if (p3 > g3End) break;
        } else {
          const nx3 = skipField(headBuf, t3[1], wt3);
          if (nx3 < 0 || nx3 > g3End) break;
          p3 = nx3;
        }
      }
      pos = g3Start + g3Len;
      if (pos > headBuf.length) break;
    } else {
      const nx = skipField(headBuf, p1, wt);
      if (nx < 0 || nx > headBuf.length) break;
      pos = nx;
    }
  }
  return maxWin;
}

export function findContextField9InLargeTail(tailRaw) {
  if (!tailRaw || tailRaw.length === 0) return null;
  const tb = tailRaw instanceof Uint8Array ? tailRaw : new Uint8Array(tailRaw);
  let best = null;
  for (let i = 0; i < tb.length - 8; i++) {
    if (tb[i] !== 0x4a) continue;
    const lenRes = readVarint(tb, i + 1);
    if (!lenRes) continue;
    const [slen, sStart] = lenRes;
    const sEnd = sStart + slen;
    if (slen < 6 || slen > 96_000 || sEnd > tb.length) continue;
    if (sEnd < tb.length) {
      const nextTag = readVarint(tb, sEnd);
      if (!nextTag) continue;
      const nfn = Math.floor(nextTag[0] / 8);
      const nwt = nextTag[0] & 7;
      if (nfn < 10 || nfn > 32 || (nwt !== 0 && nwt !== 2)) continue;
    }
    const parsed = parseContextField9Submessage(tb, sStart, sEnd);
    if (parsed && (parsed.maxContextTokens >= 1000 || parsed.breakdown.length > 0)) {
      best = parsed;
    }
  }
  return best;
}

export function parseKvPairSubmessage(buf, start, end) {
  let pos = start;
  let key = '';
  let val = '';
  while (pos < end) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, p1] = tagRes;
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (wireType === 2) {
      const lenRes = readVarint(buf, p1);
      if (!lenRes) break;
      const [slen, sStart] = lenRes;
      const sEnd = sStart + slen;
      if (sEnd > end) break;
      if (fieldNum === 1 && slen > 0 && slen <= 64) {
        key = UTF8_DECODER.decode(buf.subarray(sStart, sEnd));
      } else if (fieldNum === 2 && slen > 0 && slen <= 128) {
        val = UTF8_DECODER.decode(buf.subarray(sStart, sEnd));
      }
      pos = sEnd;
    } else {
      pos = skipField(buf, p1, wireType);
      if (pos < 0) break;
    }
  }
  return { key, val };
}

export function parseModelUsageSubmessage(buf, start, end) {
  let pos = start;
  let modelEnum = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let apiProvider = 0;
  let thinkingTokens = 0;
  let responseTokens = 0;
  let botId = '';
  let sessionId = '';
  let responseId = '';

  while (pos < end) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, p1] = tagRes;
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 7;

    if (wireType === 0) {
      const vRes = readVarint(buf, p1);
      if (!vRes) break;
      const val = vRes[0];
      pos = vRes[1];
      switch (fieldNum) {
        case 1:
          modelEnum = val;
          break;
        case 2:
          inputTokens = val;
          break;
        case 3:
          outputTokens = val;
          break;
        case 4:
          cacheWriteTokens = val;
          break;
        case 5:
          cacheReadTokens = val;
          break;
        case 6:
          apiProvider = val;
          break;
        case 9:
          thinkingTokens = val;
          break;
        case 10:
          responseTokens = val;
          break;
        default:
          break;
      }
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, p1);
      if (!lenRes) break;
      const [subLen, subStart] = lenRes;
      const subEnd = subStart + subLen;
      if (subEnd > end) break;
      if (fieldNum === 7 && subLen > 0 && subLen <= 96) {
        botId = UTF8_DECODER.decode(buf.subarray(subStart, subEnd));
      } else if (fieldNum === 8 && subLen > 0 && subLen <= 160) {
        const kv = parseKvPairSubmessage(buf, subStart, subEnd);
        if (kv.key === 'sessionID' && kv.val) sessionId = kv.val;
      } else if (fieldNum === 11 && subLen > 0 && subLen <= 128) {
        responseId = UTF8_DECODER.decode(buf.subarray(subStart, subEnd));
      }
      pos = subEnd;
    } else {
      pos = skipField(buf, p1, wireType);
      if (pos < 0) break;
    }
  }

  if (outputTokens > 0) {
    if (thinkingTokens === 0 && responseTokens === 0) {
      responseTokens = outputTokens;
    } else if (thinkingTokens > 0 && responseTokens === 0 && outputTokens >= thinkingTokens) {
      responseTokens = outputTokens - thinkingTokens;
    } else if (responseTokens > 0 && thinkingTokens === 0 && outputTokens >= responseTokens) {
      thinkingTokens = outputTokens - responseTokens;
    }
  }

  return {
    modelEnum,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    apiProvider,
    thinkingTokens,
    responseTokens,
    botId,
    sessionId,
    responseId,
  };
}

/**
 * Wire-tag extractor for `gen_metadata` (full small row `<= 8192B`, or `head` 6KB + `tail` 1.5KB slices).
 */
export function parseGenMetadataSliceRow(idx, headRaw, tailRaw, fullRaw = null) {
  const full = fullRaw
    ? fullRaw instanceof Uint8Array
      ? fullRaw
      : new Uint8Array(fullRaw)
    : null;
  const tailSlice = tailRaw
    ? tailRaw instanceof Uint8Array
      ? tailRaw
      : new Uint8Array(tailRaw)
    : null;
  const t = full && full.length > 0
    ? full.length > 2048
      ? full.subarray(full.length - 2048)
      : full
    : tailSlice;
  if (!t || t.length === 0) return null;

  const h = full && full.length > 0
    ? full
    : headRaw
      ? headRaw instanceof Uint8Array
        ? headRaw
        : new Uint8Array(headRaw)
      : t;

  const ctx9 = full && full.length > 0 ? extractContextField9FromRoot(full) : null;
  const dynamicMaxWindow = extractMaxWindowFromHead(h);

  let desiredSlug = '';
  let rawSlug = '';
  let placeholder = '';
  let displayName = '';
  let traceHash = '';
  let botId = '';
  let responseId = '';

  for (let i = 0; i < h.length - 5; i++) {
    if (h[i] === 0xe2 && h[i + 1] === 0x01) {
      const slen = h[i + 2];
      const sStart = i + 3;
      const sEnd = sStart + slen;
      if (slen >= 4 && slen <= 80 && sEnd <= h.length && isAsciiPrintableRange(h, sStart, sEnd)) {
        const candidate = UTF8_DECODER.decode(h.subarray(sStart, sEnd));
        if (VALID_RAW_SLUG_RE.test(candidate) && candidate.includes('-') && !UUID_PREFIX_RE.test(candidate)) {
          desiredSlug = candidate;
        }
      }
    }
  }

  for (let i = 0; i < t.length - 4; i++) {
    const b0 = t[i];

    if (
      !botId &&
      b0 === 0x62 &&
      i + 40 <= t.length &&
      t[i + 1] === 0x6f &&
      t[i + 2] === 0x74 &&
      t[i + 3] === 0x2d &&
      isAsciiPrintableRange(t, i, i + 40)
    ) {
      const candBot = UTF8_DECODER.decode(t.subarray(i, i + 40));
      if (/^bot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candBot)) {
        botId = candBot;
      }
    }

    if (t[i + 1] !== 0x01) continue;
    const slen = t[i + 2];
    const sStart = i + 3;
    const sEnd = sStart + slen;

    if (b0 === 0x9a && slen >= 4 && slen <= 80 && sEnd <= t.length) {
      if (isAsciiPrintableRange(t, sStart, sEnd)) {
        const cand = UTF8_DECODER.decode(t.subarray(sStart, sEnd));
        if (VALID_RAW_SLUG_RE.test(cand) && !UUID_PREFIX_RE.test(cand)) {
          rawSlug = cand;
        }
      }
    } else if (b0 === 0xaa && slen >= 4 && slen <= 96 && sEnd <= t.length) {
      if (isAsciiPrintableRange(t, sStart, sEnd)) {
        const cand = UTF8_DECODER.decode(t.subarray(sStart, sEnd));
        if (VALID_DISPLAY_MODEL_RE.test(cand) && !UUID_PREFIX_RE.test(cand)) {
          displayName = cand.trim();
        }
      }
    } else if (b0 === 0xa2 && slen >= 6 && slen <= 120 && sEnd <= t.length) {
      if (t[sStart] === 0x0a) {
        const kLen = t[sStart + 1];
        const vTagIdx = sStart + 2 + kLen;
        if (vTagIdx + 2 <= sEnd && t[vTagIdx] === 0x12) {
          const vLen = t[vTagIdx + 1];
          if (vTagIdx + 2 + vLen === sEnd && isAsciiPrintableRange(t, sStart + 2, sStart + 2 + kLen)) {
            const key = UTF8_DECODER.decode(t.subarray(sStart + 2, sStart + 2 + kLen));
            if (key === 'model_enum' && isAsciiPrintableRange(t, vTagIdx + 2, sEnd)) {
              placeholder = UTF8_DECODER.decode(t.subarray(vTagIdx + 2, sEnd));
            }
          }
        }
      }
    } else if (b0 === 0x8a) {
      const lenRes = readVarint(t, i + 2);
      if (lenRes) {
        const [subLen, subStart] = lenRes;
        const subEnd = subStart + subLen;
        if (subLen >= 10 && subLen <= 600 && subEnd <= t.length) {
          let sp = subStart;
          while (sp < subEnd) {
            const st = readVarint(t, sp);
            if (!st) break;
            const [stag, sp1] = st;
            const sfn = Math.floor(stag / 8);
            const swt = stag & 7;
            if (swt === 2) {
              const sl = readVarint(t, sp1);
              if (!sl) break;
              const [innerLen, innerStart] = sl;
              const innerEnd = innerStart + innerLen;
              if (innerEnd > subEnd) break;
              if (sfn === 4 && innerLen >= 8 && innerLen <= 32 && isAsciiPrintableRange(t, innerStart, innerEnd)) {
                const hCand = UTF8_DECODER.decode(t.subarray(innerStart, innerEnd));
                if (/^[0-9a-f]{12,32}$/i.test(hCand)) {
                  traceHash = `0x${hCand}`;
                }
              } else if (sfn === 2) {
                const subUsage = parseModelUsageSubmessage(t, innerStart, innerEnd);
                if (!botId && subUsage.botId) botId = subUsage.botId;
                if (!responseId && subUsage.responseId) responseId = subUsage.responseId;
              }
              sp = innerEnd;
            } else {
              sp = skipField(t, sp1, swt);
              if (sp < 0) break;
            }
          }
        }
      }
    }
  }

  const enumId = placeholderToEnum(placeholder);
  const { code } = enumToModelCode(enumId);

  return {
    idx,
    enumId,
    code,
    placeholder,
    rawSlug,
    displayName,
    desiredSlug,
    botId,
    responseId,
    traceHash,
    dynamicMaxWindow: dynamicMaxWindow || 0,
    checkpointStepIndex: ctx9 ? ctx9.checkpointStepIndex : 0,
    hasCheckpointField: Boolean(ctx9?.hasCheckpointField),
    estimatedTokensUsed: ctx9 ? ctx9.estimatedTokensUsed : 0,
    truncationReason: ctx9 ? ctx9.truncationReason : 0,
    maxContextTokens: ctx9 ? ctx9.maxContextTokens : 0,
    breakdown: ctx9 ? ctx9.breakdown : [],
  };
}

/**
 * Decodes `steps.metadata` (`CortexStepMetadata` protobuf) in one pass.
 */
export function parseStepMetadata(rawBuf) {
  if (!rawBuf || rawBuf.length === 0) {
    return {
      t1: 0,
      t6: 0,
      t7: 0,
      modelEnum: 0,
      requestedEnum: 0,
      respondedEnum: 0,
      usage: null,
    };
  }
  const buf = rawBuf instanceof Uint8Array ? rawBuf : new Uint8Array(rawBuf);
  let pos = 0;
  const len = buf.length;
  let t1 = 0;
  let t6 = 0;
  let t7 = 0;
  let topModelEnum = 0;
  let usage = null;

  while (pos < len) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, p1] = tagRes;
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 7;

    if (wireType === 2) {
      const lenRes = readVarint(buf, p1);
      if (!lenRes) break;
      const [subLen, subStart] = lenRes;
      const subEnd = subStart + subLen;
      if (subEnd > len) break;

      if (fieldNum === 1) {
        t1 = parseProtoTimestamp(buf, subStart, subEnd);
      } else if (fieldNum === 6) {
        t6 = parseProtoTimestamp(buf, subStart, subEnd);
      } else if (fieldNum === 7) {
        t7 = parseProtoTimestamp(buf, subStart, subEnd);
      } else if (fieldNum === 9) {
        usage = parseModelUsageSubmessage(buf, subStart, subEnd);
      }
      pos = subEnd;
    } else if (wireType === 0) {
      const vRes = readVarint(buf, p1);
      if (!vRes) break;
      if (fieldNum === 11) {
        topModelEnum = vRes[0];
      }
      pos = vRes[1];
    } else {
      pos = skipField(buf, p1, wireType);
      if (pos < 0) break;
    }
  }

  const requestedEnum = topModelEnum || 0;
  const respondedEnum = (usage && usage.modelEnum) || 0;
  const resolvedEnum = respondedEnum || requestedEnum || 0;
  if (usage && !usage.modelEnum && requestedEnum) {
    usage.modelEnum = requestedEnum;
  }

  return {
    t1,
    t6,
    t7,
    modelEnum: resolvedEnum,
    requestedEnum,
    respondedEnum,
    usage,
  };
}

export function extractSummaryFromStepPayload(rawBuf) {
  if (!rawBuf || rawBuf.length === 0) return '';
  const buf = rawBuf instanceof Uint8Array ? rawBuf : new Uint8Array(rawBuf);
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, p1] = tagRes;
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (wireType === 2) {
      const lenRes = readVarint(buf, p1);
      if (!lenRes) break;
      const [subLen, subStart] = lenRes;
      const subEnd = subStart + subLen;
      if (subEnd > buf.length) break;
      if (fieldNum === 30) {
        let sp = subStart;
        while (sp < subEnd) {
          const stRes = readVarint(buf, sp);
          if (!stRes) break;
          const [stag, sp1] = stRes;
          const sfn = Math.floor(stag / 8);
          const swt = stag & 7;
          if (swt === 2) {
            const slRes = readVarint(buf, sp1);
            if (!slRes) break;
            const [slen, ssStart] = slRes;
            const ssEnd = ssStart + slen;
            if (ssEnd > subEnd) break;
            if (sfn === 5 && slen > 0) {
              return UTF8_DECODER.decode(buf.subarray(ssStart, ssEnd));
            }
            sp = ssEnd;
          } else {
            sp = skipField(buf, sp1, swt);
            if (sp < 0) break;
          }
        }
      }
      pos = subEnd;
    } else {
      pos = skipField(buf, p1, wireType);
      if (pos < 0) break;
    }
  }
  return '';
}

export function extractPromptFromStepPayload(rawBuf, stepType) {
  if (!rawBuf || rawBuf.length === 0) {
    return { rawText: '', hasMedia: false, createdSec: 0 };
  }
  const buf = rawBuf instanceof Uint8Array ? rawBuf : new Uint8Array(rawBuf);
  let pos = 0;
  let createdSec = 0;
  let rawQuery = '';
  const chunks = [];
  let hasMedia = false;
  let sysPrimary = '';
  let sysSecondary = '';
  let sysFallback = '';

  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, p1] = tagRes;
    const fn = Math.floor(tag / 8);
    const wt = tag & 7;

    if (wt === 2) {
      const lenRes = readVarint(buf, p1);
      if (!lenRes) break;
      const [subLen, subStart] = lenRes;
      const subEnd = subStart + subLen;
      if (subEnd > buf.length) break;

      if (fn === 5) {
        let sp = subStart;
        while (sp < subEnd) {
          const st = readVarint(buf, sp);
          if (!st) break;
          const sfn = Math.floor(st[0] / 8);
          const swt = st[0] & 7;
          if (sfn === 1 && swt === 2) {
            const sl = readVarint(buf, st[1]);
            if (sl && sl[1] + sl[0] <= subEnd) {
              createdSec = parseProtoTimestamp(buf, sl[1], sl[1] + sl[0]);
            }
            break;
          }
          sp = skipField(buf, st[1], swt);
          if (sp < 0) break;
        }
      } else if (stepType === 14 && fn === 19) {
        let sp = subStart;
        while (sp < subEnd) {
          const st = readVarint(buf, sp);
          if (!st) break;
          const sfn = Math.floor(st[0] / 8);
          const swt = st[0] & 7;
          if (swt === 2) {
            const sl = readVarint(buf, st[1]);
            if (!sl) break;
            const [ilen, iStart] = sl;
            const iEnd = iStart + ilen;
            if (iEnd > subEnd) break;
            if (sfn === 2 && ilen > 0) {
              rawQuery = UTF8_DECODER.decode(buf.subarray(iStart, iEnd));
            } else if (sfn === 3 && ilen > 0) {
              let cp = iStart;
              while (cp < iEnd) {
                const ct = readVarint(buf, cp);
                if (!ct) break;
                const cfn = Math.floor(ct[0] / 8);
                const cwt = ct[0] & 7;
                if (cwt === 2) {
                  const cl = readVarint(buf, ct[1]);
                  if (!cl) break;
                  const [clen, cStart] = cl;
                  const cEnd = cStart + clen;
                  if (cEnd > iEnd) break;
                  if (cfn === 1 && clen > 0) {
                    chunks.push(UTF8_DECODER.decode(buf.subarray(cStart, cEnd)));
                  } else if (cfn === 2 && clen > 0) {
                    hasMedia = true;
                  }
                  cp = cEnd;
                } else {
                  cp = skipField(buf, ct[1], cwt);
                  if (cp < 0) break;
                }
              }
            } else if ((sfn === 4 || sfn === 9) && ilen > 0) {
              hasMedia = true;
            }
            sp = iEnd;
          } else {
            sp = skipField(buf, st[1], swt);
            if (sp < 0) break;
          }
        }
      } else if (stepType === 101 && fn === 114) {
        let sp = subStart;
        while (sp < subEnd) {
          const st = readVarint(buf, sp);
          if (!st) break;
          const sfn = Math.floor(st[0] / 8);
          const swt = st[0] & 7;
          if (swt === 2) {
            const sl = readVarint(buf, st[1]);
            if (!sl) break;
            const [ilen, iStart] = sl;
            const iEnd = iStart + ilen;
            if (iEnd > subEnd) break;
            if (sfn === 1 && ilen > 0 && !sysFallback) {
              sysFallback = UTF8_DECODER.decode(buf.subarray(iStart, iEnd));
            } else if (sfn === 2 && ilen > 0 && !sysSecondary) {
              let cp = iStart;
              while (cp < iEnd) {
                const ct = readVarint(buf, cp);
                if (!ct) break;
                const cfn = Math.floor(ct[0] / 8);
                const cwt = ct[0] & 7;
                if (cwt === 2) {
                  const cl = readVarint(buf, ct[1]);
                  if (!cl) break;
                  const [clen, cStart] = cl;
                  const cEnd = cStart + clen;
                  if (cEnd > iEnd) break;
                  if (cfn === 10 && clen > 0) {
                    let dp = cStart;
                    while (dp < cEnd) {
                      const dt = readVarint(buf, dp);
                      if (!dt) break;
                      if (Math.floor(dt[0] / 8) === 1 && (dt[0] & 7) === 2) {
                        const dl = readVarint(buf, dt[1]);
                        if (dl && dl[1] + dl[0] <= cEnd && dl[0] > 0) {
                          sysSecondary = UTF8_DECODER.decode(
                            buf.subarray(dl[1], dl[1] + dl[0])
                          );
                        }
                        break;
                      }
                      dp = skipField(buf, dt[1], dt[0] & 7);
                      if (dp < 0) break;
                    }
                  }
                  cp = cEnd;
                } else {
                  cp = skipField(buf, ct[1], cwt);
                  if (cp < 0) break;
                }
              }
            } else if (sfn === 4 && ilen > 0) {
              let cp = iStart;
              while (cp < iEnd) {
                const ct = readVarint(buf, cp);
                if (!ct) break;
                const cfn = Math.floor(ct[0] / 8);
                const cwt = ct[0] & 7;
                if (cwt === 2) {
                  const cl = readVarint(buf, ct[1]);
                  if (!cl) break;
                  const [clen, cStart] = cl;
                  const cEnd = cStart + clen;
                  if (cEnd > iEnd) break;
                  if (cfn === 4 && clen > 0) {
                    sysPrimary = UTF8_DECODER.decode(buf.subarray(cStart, cEnd));
                  }
                  cp = cEnd;
                } else {
                  cp = skipField(buf, ct[1], cwt);
                  if (cp < 0) break;
                }
              }
            }
            sp = iEnd;
          } else {
            sp = skipField(buf, st[1], swt);
            if (sp < 0) break;
          }
        }
      }
      pos = subEnd;
    } else {
      pos = skipField(buf, p1, wt);
      if (pos < 0) break;
    }
  }

  const rawText =
    stepType === 14
      ? rawQuery.trim() || chunks.join('').trim()
      : sysPrimary.trim() || sysSecondary.trim() || sysFallback.trim();

  return { rawText, hasMedia, createdSec };
}

/**
 * Strips `<CONTEXT_SUMMARY>`, `<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`,
 * `<SKILL>`, and system injection wrappers, preferring `<USER_REQUEST>` text
 * and tagging `[plan review]` hidden Orchestrator messages.
 */
export function cleanTurnPrompt(
  rawInput,
  { isSystem = false, hasMedia = false, fallbackLabel = '' } = {}
) {
  let text = String(rawInput || '').replace(/\r\n/g, '\n');

  text = text.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '');
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  text = text.replace(/<EPHEMERAL_MESSAGE>[\s\S]*?<\/EPHEMERAL_MESSAGE>/gi, '');
  text = text.replace(/<SKILL>[\s\S]*?<\/SKILL>/gi, '');
  text = text.replace(/<ATTACHMENT_SUMMARY>[\s\S]*?<\/ATTACHMENT_SUMMARY>/gi, '');
  text = text.replace(/<USER_ADDED_REFS>[\s\S]*?<\/USER_ADDED_REFS>/gi, '');

  const reqMatches = [...text.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi)];
  if (reqMatches.length > 0) {
    text = reqMatches[reqMatches.length - 1][1];
  } else {
    const openIdx = text.lastIndexOf('<USER_REQUEST>');
    if (openIdx >= 0) {
      text = text.slice(openIdx + '<USER_REQUEST>'.length);
    }
  }

  text = text.replace(/<CONTEXT_SUMMARY>[\s\S]*$/gi, '');
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*$/gi, '');
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*$/gi, '');
  text = text.replace(/<EPHEMERAL_MESSAGE>[\s\S]*$/gi, '');
  text = text.replace(
    /^#\s*Resuming from a compaction\s*\n+You are continuing work on the task described above[^\n]*\n+/i,
    ''
  );
  text = text.replace(
    /The following is a <SYSTEM_MESSAGE> not actually sent by the user\.[^\n]*\n*/gi,
    ''
  );
  text = text.replace(/<\/?(?:SYSTEM_MESSAGE|USER_REQUEST)>/gi, '');

  const msgEnv = text.match(
    /^\[Message\]\s+timestamp=\S+\s+sender=\S+\s+priority=\S+\s+content=([\s\S]+)$/
  );
  if (msgEnv) {
    text = msgEnv[1];
  }

  text = scrubInterpuncts(text).replace(/\n{3,}/g, '\n\n').trim();

  let kindHint = '';
  if (/^\[plan review(?:\s+due)?\]/i.test(text)) {
    kindHint = 'plan_review';
    const body = text.replace(/^\[plan review(?:\s+due)?\]\s*/i, '').trim();
    text = body ? `[规划复核] ${body}` : '[规划复核]';
  } else if (
    isSystem &&
    /^Above is the conversation history from the parent conversation[^\n]*\bside question\s*\(\/btw\)\s*branched from that conversation\b/i.test(
      text
    )
  ) {
    kindHint = 'btw_marker';
    return {
      preview: '/btw 侧问分支',
      promptText: text,
      kindHint,
    };
  }

  if (!text) {
    text = scrubInterpuncts(
      fallbackLabel ||
        (hasMedia ? '[图片或附件消息]' : isSystem ? '[系统任务唤醒]' : '[用户消息]')
    );
  }

  const singleLine = text.replace(/\s+/g, ' ').trim();
  const preview =
    singleLine.length > 140
      ? `${singleLine.slice(0, 139).trimEnd()}…`
      : singleLine;
  const promptText =
    text.length > 500 ? `${text.slice(0, 499).trimEnd()}…` : text;

  return { preview, promptText, kindHint };
}

export function parseChapterTitlesProto(rawBuf) {
  if (!rawBuf || rawBuf.length === 0) return [];
  const buf = rawBuf instanceof Uint8Array ? rawBuf : new Uint8Array(rawBuf);
  const chapters = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, p1] = tagRes;
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (fieldNum === 1 && wireType === 2) {
      const lenRes = readVarint(buf, p1);
      if (!lenRes) break;
      const [subLen, subStart] = lenRes;
      const subEnd = subStart + subLen;
      if (subEnd > buf.length) break;
      let sp = subStart;
      let startStep = 0;
      let endStep = 0;
      let title = '';
      while (sp < subEnd) {
        const stRes = readVarint(buf, sp);
        if (!stRes) break;
        const [stag, sp1] = stRes;
        const sfn = Math.floor(stag / 8);
        const swt = stag & 7;
        if (swt === 0) {
          const vRes = readVarint(buf, sp1);
          if (!vRes) break;
          if (sfn === 1) startStep = vRes[0];
          else if (sfn === 2) endStep = vRes[0];
          sp = vRes[1];
        } else if (swt === 2) {
          const slRes = readVarint(buf, sp1);
          if (!slRes) break;
          const [slen, ssStart] = slRes;
          const ssEnd = ssStart + slen;
          if (ssEnd > subEnd) break;
          if (sfn === 3 && slen > 0) {
            title = scrubInterpuncts(
              UTF8_DECODER.decode(buf.subarray(ssStart, ssEnd)).trim()
            );
          }
          sp = ssEnd;
        } else {
          sp = skipField(buf, sp1, swt);
          if (sp < 0) break;
        }
      }
      if (title) {
        chapters.push({
          index: chapters.length + 1,
          startStep,
          endStep,
          title,
        });
      }
      pos = subEnd;
    } else {
      pos = skipField(buf, p1, wireType);
      if (pos < 0) break;
    }
  }
  return chapters;
}

export function cleanCompactedSummary(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let text = rawText.replace(/\r\n/g, '\n').trim();

  const standaloneMatches = [
    ...text.matchAll(
      /(?:^|\n)[ \t]*<summary>[ \t]*\n([\s\S]*?)\n[ \t]*<\/summary>[ \t]*(?=\n|$)/gi
    ),
  ];
  if (standaloneMatches.length > 0) {
    const inner = scrubInterpuncts(standaloneMatches[standaloneMatches.length - 1][1])
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (inner) return inner;
  }

  const inlineTagMatches = [...text.matchAll(/<summary>([\s\S]*?)<\/summary>/gi)];
  if (inlineTagMatches.length > 0) {
    const inner = scrubInterpuncts(inlineTagMatches[inlineTagMatches.length - 1][1])
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (inner) return inner;
  }

  text = text.replace(
    /^#\s*Resuming from a compaction\s*\n+You are continuing work on the task described above[^\n]*\n+/i,
    ''
  );
  text = text.replace(
    /^The following is a summary of the conversation history that has been truncated[^\n]*\n+(?:This summary was generated at [^\n]*\n+)?/i,
    ''
  );
  text = text.replace(
    /^\{\{\s*CHECKPOINT\s+\d+\s*\}\}\s*\*\*The earlier parts of this conversation have been truncated[\s\S]*?\*\*\s*\n*/i,
    ''
  );
  text = text.replace(
    /^(#\s*User Requests)\s*\n+The following were user requests from the truncated conversation in chronological order:\s*\n+/im,
    '$1\n\n'
  );
  text = text.replace(
    /^(#\s*Parent Agent Messages)\s*\n+The following were (?:the most recent )?messages from your parent agent[^\n]*\n+/im,
    '$1\n\n'
  );
  text = text.replace(
    /\n*#\s*Conversation Logs\s*\n+Start with the compact transcript[\s\S]*$/i,
    ''
  );
  text = text.replace(
    /\n*You have the \d+ following artifacts written to the artifacts directory:\s*\n+/i,
    '\n\n# Workspace Artifacts\n\n'
  );
  text = text.replace(
    /\[ARTIFACT:\s*media_\d+_[a-f0-9]+\]\s*\nPath:[^\n]*\.user_uploaded[^\n]*\nLast Edited:[^\n]*\n*/gi,
    ''
  );
  text = text.replace(/\n+# Workspace Artifacts\s*$/i, '');

  text = scrubInterpuncts(text).replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

/**
 * Extracts printable error / server-injection message, category classification,
 * retry counter, and quota/safety detection from `step_type = 17` (`ERROR_MESSAGE`)
 * `step_payload` prefix slices while filtering legacy IDE file-tool false positives.
 */
export function parseErrorStepSlice(rawSlice) {
  const empty = {
    ignored: false,
    category: '',
    message: '',
    fullText: '',
    isQuotaError: false,
    retriesRemaining: null,
    attempt: null,
  };
  if (!rawSlice || rawSlice.length === 0) {
    return empty;
  }
  const buf = rawSlice instanceof Uint8Array ? rawSlice : new Uint8Array(rawSlice);
  const rawStr = UTF8_DECODER.decode(buf);

  if (LEGACY_TOOL_IN_17_RE.test(rawStr)) {
    return { ...empty, ignored: true };
  }

  let cleaned = rawStr
    .replace(/\r\n/g, '\n')
    .replace(/[^\x20-\x7e\n\u4e00-\u9fff]+/g, ' ')
    .replace(/2[\x20-\x7e]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+[\s\S]*$/i, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  const anchorMatch = ERROR_ANCHOR_RE.exec(cleaned);
  let fullText = '';
  if (anchorMatch) {
    fullText = cleaned.slice(anchorMatch.index).trim();
  } else {
    const runs = cleaned.match(/[\x20-\x7e\u4e00-\u9fff]{8,}/g) || [];
    let best = '';
    for (const run of runs) {
      const candidate = run
        .replace(/^[A-Za-z0-9_.*+/=:-]{1,4}\$/, '')
        .replace(
          /^[A-Za-z|\\](?=(?:API error|There was a network issue|The stream was interrupted|Your previous response|Model produced invalid output|Guidance:|model output error:))/,
          ''
        )
        .trim();
      if (!candidate) continue;
      if (/^[0-9a-f-]{32,36}$/i.test(candidate)) continue;
      if (/^[0-9a-f]{24,}$/i.test(candidate)) continue;
      if (
        QUOTA_ERROR_RE.test(candidate) ||
        SAFETY_FILTER_RE.test(candidate) ||
        SERVER_INJECTION_RE.test(candidate) ||
        UPSTREAM_RETRY_RE.test(candidate) ||
        /API error|failed|error|timeout|unavailable|invalid|denied/i.test(candidate)
      ) {
        if (candidate.length > best.length) best = candidate;
      } else if (!best && candidate.length > 12) {
        best = candidate;
      }
    }
    fullText = best;
  }

  fullText = fullText
    .replace(
      /^[A-Za-z|\\](?=(?:API error|There was a network issue|The stream was interrupted|Your previous response|Model produced invalid output|Guidance:|model output error:))/,
      ''
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (fullText.length > 900) {
    fullText = `${fullText.slice(0, 899).trimEnd()}…`;
  }

  const singleLine = fullText.replace(/\s*\n+\s*/g, ' ').trim();
  const message =
    singleLine.length > 160 ? `${singleLine.slice(0, 159).trimEnd()}…` : singleLine;

  let category = '';
  if (SAFETY_FILTER_RE.test(fullText) || SAFETY_FILTER_RE.test(rawStr)) {
    category = 'safety_filter';
  } else if (QUOTA_ERROR_RE.test(fullText) || QUOTA_ERROR_RE.test(rawStr)) {
    category = 'quota_429';
  } else if (SERVER_INJECTION_RE.test(fullText) || SERVER_INJECTION_RE.test(rawStr)) {
    category = 'server_injection';
  } else if (UPSTREAM_RETRY_RE.test(fullText) || UPSTREAM_RETRY_RE.test(rawStr)) {
    category = 'upstream_retry';
  } else if (/error|failed|timeout|unavailable|denied/i.test(fullText)) {
    category = 'upstream_retry';
  } else if (fullText) {
    category = 'server_injection';
  }

  const retryMatch = fullText.match(/Retries remaining:\s*(\d+)/i);
  const retriesRemaining = retryMatch ? Number(retryMatch[1]) : null;
  const attemptMatch = fullText.match(/\battempt\s*(\d+)\b/i);
  const attempt = attemptMatch ? Number(attemptMatch[1]) : null;

  return {
    ignored: false,
    category,
    message,
    fullText,
    isQuotaError: category === 'quota_429',
    retriesRemaining,
    attempt,
  };
}

/**
 * Extracts tool name and failure classification from failed/rejected
 * `step_type = 132` (`status = 6` rejected or `status = 7` error) `step_payload` heads.
 */
export function parseToolFailureSlice(rawHeadSlice, status = 7) {
  const isRejected = Number(status) === 6;
  let toolName = '';
  if (rawHeadSlice && rawHeadSlice.length > 0) {
    const buf =
      rawHeadSlice instanceof Uint8Array
        ? rawHeadSlice
        : new Uint8Array(rawHeadSlice);
    const printable = UTF8_DECODER.decode(buf).replace(/[^\x20-\x7e]+/g, ' ');
    const callMatch = printable.match(/call_[A-Za-z0-9_-]+\s+([a-zA-Z][a-zA-Z0-9_.-]{1,63})/);
    if (callMatch) {
      toolName = callMatch[1];
    } else {
      const fbMatch = printable.match(
        /\b(run_command|read_file|write_file|edit_file|multi_replace_file_content|replace_file_content|write_to_file|view_file|grep_search|find_by_name|list_dir|search_web|read_url_content|generate_image|invoke_subagent|send_message|browser)\b/
      );
      if (fbMatch) toolName = fbMatch[1];
    }
  }
  const message = isRejected
    ? `工具调用被拒绝${toolName ? `: ${toolName}` : ''}`
    : `工具执行失败${toolName ? `: ${toolName}` : ''}`;
  return {
    category: 'tool_error',
    toolName,
    isRejected,
    message,
  };
}

/**
 * Detects host-injected restart interruption notices inside `step_type = 101` payloads.
 */
export function detectSystemInjection101(rawSliceOrText) {
  if (!rawSliceOrText) return null;
  let text = '';
  if (typeof rawSliceOrText === 'string') {
    text = rawSliceOrText;
  } else {
    const ext = extractPromptFromStepPayload(rawSliceOrText, 101);
    text = ext.rawText || UTF8_DECODER.decode(
      rawSliceOrText instanceof Uint8Array ? rawSliceOrText : new Uint8Array(rawSliceOrText)
    ).replace(/[^\x20-\x7e\n\u4e00-\u9fff]+/g, ' ');
  }
  const markerRe =
    /\[Notice\]\s*All your subagents and background tasks have been stopped due to server restart[^\n]*/i;
  const m = text.match(markerRe);
  if (!m) return null;
  return {
    category: 'server_injection',
    message: '服务端重启导致后台任务与子代理被强制中断',
    fullText: m[0].trim(),
  };
}

/**
 * Extracts image model slug and generated media presence from the 512B tail
 * of a completed `generate_image` (`step_type = 132`) `step_payload`.
 * Case-sensitive lowercase match avoids swallowing protobuf field tag `'B'`
 * in sequences like `gemini-3.1-flash-imageB`.
 */
export function parseImageGenStepSlice(rawTailSlice) {
  if (!rawTailSlice || rawTailSlice.length === 0) {
    return { modelSlug: '', hasOutputFile: false };
  }
  const buf =
    rawTailSlice instanceof Uint8Array ? rawTailSlice : new Uint8Array(rawTailSlice);
  const str = UTF8_DECODER.decode(buf);
  const modelMatch = str.match(
    /(gemini-[a-z0-9.-]+-image(?:-[a-z0-9-]+)?|imagen-[a-z0-9.-]+)(?=[^a-z0-9-]|$)/
  );
  const hasOutputFile =
    /file:\/\/\/[^\x00-\x1f"']+?\.(?:png|jpg|jpeg|webp)/i.test(str);
  return {
    modelSlug: modelMatch ? modelMatch[1] : '',
    hasOutputFile,
  };
}

/**
 * Decodes structured `/btw` branch or parent fork metadata from a `parent_references.data` blob.
 * Wire layout observed in Antigravity SQLite trajectories:
 * - `field 1` (string): parent `trajectory_id`
 * - `field 2` (varint): `parentStepIndex` (last cloned step index)
 * - `field 5` (varint): `refType` (`2` for branch/fork)
 * - `field 6` (string): `parentConversationId` (parent Cascade conversation UUID)
 */
export function parseParentRefProto(rawBuf) {
  const empty = {
    parentTrajectoryId: '',
    parentStepIndex: -1,
    refType: 0,
    parentConversationId: '',
  };
  if (!rawBuf || rawBuf.length === 0) return empty;
  const buf = rawBuf instanceof Uint8Array ? rawBuf : new Uint8Array(rawBuf);
  let pos = 0;
  let parentTrajectoryId = '';
  let parentStepIndex = -1;
  let refType = 0;
  let parentConversationId = '';

  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, p1] = tagRes;
    const fn = Math.floor(tag / 8);
    const wt = tag & 7;
    if (wt === 0) {
      const vRes = readVarint(buf, p1);
      if (!vRes) break;
      if (fn === 2) parentStepIndex = vRes[0];
      else if (fn === 5) refType = vRes[0];
      pos = vRes[1];
    } else if (wt === 2) {
      const lenRes = readVarint(buf, p1);
      if (!lenRes || lenRes[1] + lenRes[0] > buf.length) break;
      const [len, start] = lenRes;
      if (fn === 1 && len >= 32 && len <= 64) {
        const s = UTF8_DECODER.decode(buf.subarray(start, start + len)).trim();
        if (VALID_CONV_UUID_RE.test(s)) parentTrajectoryId = s.toLowerCase();
      } else if (fn === 6 && len >= 32 && len <= 64) {
        const s = UTF8_DECODER.decode(buf.subarray(start, start + len)).trim();
        if (VALID_CONV_UUID_RE.test(s)) parentConversationId = s.toLowerCase();
      }
      pos = start + len;
    } else {
      pos = skipField(buf, p1, wt);
      if (pos < 0) break;
    }
  }

  return {
    parentTrajectoryId,
    parentStepIndex,
    refType,
    parentConversationId,
  };
}

/**
 * Extracts distinct valid referenced conversation UUIDs from `parent_references`
 * rows (which record `@mention` conversation refs, forks, etc.).
 */
export function parseParentReferencesRows(rows, selfConvId = '') {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const seen = new Set();
  const selfLower = String(selfConvId || '').toLowerCase();
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  for (const row of rows) {
    const raw = row?.data ?? row;
    if (!raw) continue;
    const str =
      raw instanceof Uint8Array
        ? UTF8_DECODER.decode(raw)
        : Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : String(raw);
    const matches = str.match(uuidRe) || [];
    for (const id of matches) {
      const lower = id.toLowerCase();
      if (lower !== selfLower && VALID_CONV_UUID_RE.test(lower)) {
        seen.add(lower);
      }
    }
  }
  return Array.from(seen);
}
