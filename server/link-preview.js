const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 128 * 1024;
const FETCH_TIMEOUT_MS = 4500;

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !host.includes('.') || host.includes(':') || /^\d+(?:\.\d+)*$/.test(host)
      || /(?:^|\.)(?:localhost|local|internal|invalid|test|onion|lan)$/.test(host)
      || /(?:^|\.)localhost$/.test(host) || url.port && !['80', '443'].includes(url.port)) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function decodeEntities(value) {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (entity[0] !== '#') return named[entity.toLowerCase()] || '';
    const number = entity[1]?.toLowerCase() === 'x'
      ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}

function cleanText(value, maxLength) {
  return decodeEntities(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function meta(html, names) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attributes = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
    }
    if (names.includes((attributes.property || attributes.name || '').toLowerCase())) {
      return attributes.content || '';
    }
  }
  return '';
}

async function readLimitedHtml(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (size < MAX_HTML_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value.subarray(0, MAX_HTML_BYTES - size));
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, MAX_HTML_BYTES));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function linkPreview(request) {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  const target = safeUrl(new URL(request.url).searchParams.get('url'));
  if (!target) return Response.json({ error: 'プレビューできないURLです。' }, { status: 400 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let url = target;
    let response;
    for (let hop = 0; hop < 4; hop += 1) {
      response = await fetch(url, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'kokopla-link-preview/1.0' },
      });
      if (response.status < 300 || response.status >= 400) break;
      const next = safeUrl(new URL(response.headers.get('location') || '', url).href);
      await response.body?.cancel();
      if (!next) return Response.json({ error: 'リダイレクト先を読み込めません。' }, { status: 422 });
      url = next;
    }
    if (!response?.ok || !/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('content-type') || '')) {
      return Response.json({ error: 'このサイトのプレビューは取得できません。' }, { status: 422 });
    }
    const html = await readLimitedHtml(response);
    const title = cleanText(meta(html, ['og:title', 'twitter:title'])
      || html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1], 120);
    const description = cleanText(meta(html, ['og:description', 'twitter:description', 'description']), 240);
    return Response.json({ title: title || url.hostname, description, host: url.hostname }, {
      headers: { 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch {
    return Response.json({ error: 'プレビューを取得できません。' }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

export async function youtubeThumbnail(request) {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  const id = new URL(request.url).searchParams.get('id');
  if (!/^[\w-]{11}$/.test(id || '')) return new Response(null, { status: 400 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, {
      signal: controller.signal, redirect: 'error',
    });
    if (!response.ok || !/^image\/jpeg\b/i.test(response.headers.get('content-type') || '')
      || Number(response.headers.get('content-length') || 0) > 512 * 1024) {
      return new Response(null, { status: 502 });
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 512 * 1024) return new Response(null, { status: 502 });
    return new Response(bytes, { headers: {
      'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch {
    return new Response(null, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
