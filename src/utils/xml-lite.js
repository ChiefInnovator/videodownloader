/**
 * Minimal XML parser for MPD manifests.
 *
 * MV3 service workers have no DOMParser, so the DASH parser uses this
 * small tree builder instead. It handles elements, attributes, text,
 * comments, CDATA, processing instructions, DOCTYPE, and the standard
 * entities — enough for DASH manifests, not a general XML implementation.
 *
 * Inventing Fire with AI — by Rich Crane
 */

/**
 * @typedef {Object} XmlElement
 * @property {string}                 name     — local name (namespace prefix stripped)
 * @property {Object<string,string>}  attrs    — attributes by local name
 * @property {XmlElement[]}           children
 * @property {string}                 text     — concatenated direct text content
 * @property {XmlElement|null}        parent
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function localName(qname) {
  const i = qname.indexOf(':');
  return i >= 0 ? qname.slice(i + 1) : qname;
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/**
 * Parse an XML string into an element tree.
 * @param {string} xml
 * @returns {XmlElement} the document (root) element
 */
export function parseXml(xml) {
  const root = { name: '#document', attrs: {}, children: [], text: '', parent: null };
  let current = root;
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      current.text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) current.text += decodeEntities(xml.slice(i, lt));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw new Error('Unterminated XML comment');
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) throw new Error('Unterminated CDATA');
      current.text += xml.slice(lt + 9, end);
      i = end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw new Error('Unterminated processing instruction');
      i = end + 2;
    } else if (xml.startsWith('<!', lt)) {
      // DOCTYPE (internal subsets with nested '>' are not expected in MPDs)
      const end = xml.indexOf('>', lt + 2);
      if (end < 0) throw new Error('Unterminated declaration');
      i = end + 1;
    } else if (xml[lt + 1] === '/') {
      const end = xml.indexOf('>', lt + 2);
      if (end < 0) throw new Error('Unterminated end tag');
      const name = localName(xml.slice(lt + 2, end).trim());
      if (current.name !== name) {
        throw new Error(`Mismatched end tag </${name}> for <${current.name}>`);
      }
      current = current.parent;
      i = end + 1;
    } else {
      // Start tag — find the closing '>' outside quoted attribute values
      let j = lt + 1;
      let quote = null;
      while (j < xml.length) {
        const c = xml[j];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === '>') {
          break;
        }
        j++;
      }
      if (j >= xml.length) throw new Error('Unterminated start tag');

      let inner = xml.slice(lt + 1, j);
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1);

      const nameMatch = inner.match(/^[^\s/>]+/);
      if (!nameMatch) throw new Error('Malformed start tag');

      const el = {
        name: localName(nameMatch[0]),
        attrs: {},
        children: [],
        text: '',
        parent: current,
      };
      ATTR_RE.lastIndex = nameMatch[0].length;
      let m;
      while ((m = ATTR_RE.exec(inner)) !== null) {
        if (m[1].startsWith('xmlns')) continue;
        el.attrs[localName(m[1])] = decodeEntities(m[3] ?? m[4]);
      }

      current.children.push(el);
      if (!selfClosing) current = el;
      i = j + 1;
    }
  }

  if (current !== root) throw new Error(`Unclosed element <${current.name}>`);
  const docEl = root.children[0];
  if (!docEl) throw new Error('Empty XML document');
  docEl.parent = null;
  return docEl;
}

/** First direct child with the given local name. */
export function child(el, name) {
  return el?.children.find(c => c.name === name) || null;
}

/** All direct children with the given local name. */
export function children(el, name) {
  return el ? el.children.filter(c => c.name === name) : [];
}

/** All descendants with the given local name (depth-first, document order). */
export function descendants(el, name, out = []) {
  if (!el) return out;
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}
