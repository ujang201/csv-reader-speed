// Fast drop-in for csv-reader 1.0.0: run({text, header}) returns exactly
// {columns, rows, errors}, the same answer csv-reader returns for that input.
//
// Original single-pass parser, written from the RULES.txt spec. Speed comes from
// bulk scanning instead of a per-character loop: an unquoted field is found with
// indexOf for the next comma / line feed, a quoted field's closing quote with
// indexOf, and a quoted field's plain content is taken with one slice. The only
// sparse character, CR, is tracked with one forward-only pointer, so no search
// ever re-scans text it already passed. No regex, no per-character string
// building in the hot paths, no state kept from one call to the next.

const COMMA = 44; // ,
const QUOTE = 34; // "
const LF = 10; // \n
const CR = 13; // \r
const END_COMMA = 0;
const END_BREAK = 1;
const END_EOF = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // Position of the next CR at or after pos, or -1 when there is none.
  // CR is sparse, so this one pointer moves only forward: every indexOf('\r')
  // below scans a stretch no earlier scan covered.
  let nextCR = text.indexOf('\r', 0);

  // The position of the next CR in [pos, limit), or -1. Keeps the pointer
  // valid: when it fell behind pos, re-find from pos.
  function crBefore(limit) {
    if (nextCR !== -1 && nextCR < pos) nextCR = text.indexOf('\r', pos);
    if (nextCR === -1 || nextCR >= limit) return -1;
    return nextCR;
  }

  // Position of the next LF at or after pos, or n when there is none. The
  // record start finds it once; a quoted field that swallows newlines leaves
  // it behind, and scanUnquoted re-finds it then. An unquoted field can never
  // run past it, so the scan below needs no indexOf('\n') of its own.
  let lineEnd = n;

  // Results of the field scan below: the field's value, how it ended, and how
  // many characters this scan itself kept (a junk scan's quote_junk test).
  let fValue = '';
  let fEnded = END_EOF;
  let fAdded = 0;

  // Reads an unquoted field starting at pos, appending onto `init`. A CR not
  // followed by LF is dropped and reported as stray_cr; a comma ends the field
  // with END_COMMA, a line break with END_BREAK, the end of the text with
  // END_EOF. A quote inside is a literal character.
  function scanUnquoted(init, rLine, rRow) {
    if (lineEnd < pos) {
      const j = text.indexOf('\n', pos);
      lineEnd = j === -1 ? n : j;
    }
    let value = init;
    let added = 0;
    for (;;) {
      const iComma = text.indexOf(',', pos);
      let i = lineEnd;
      let kind = 1;
      if (iComma !== -1 && iComma < i) { i = iComma; kind = 0; }
      const iCR = crBefore(i);
      if (iCR !== -1) { i = iCR; kind = 2; }
      if (i >= n) {
        if (pos < n) { value += text.slice(pos); added += n - pos; }
        pos = n;
        fValue = value; fEnded = END_EOF; fAdded = added;
        return;
      }
      if (kind === 0) {
        value += text.slice(pos, i); added += i - pos;
        pos = i + 1;
        fValue = value; fEnded = END_COMMA; fAdded = added;
        return;
      }
      if (kind === 1) {
        value += text.slice(pos, i); added += i - pos;
        pos = i + 1; line += 1;
        fValue = value; fEnded = END_BREAK; fAdded = added;
        return;
      }
      if (i + 1 < n && text.charCodeAt(i + 1) === LF) {
        value += text.slice(pos, i); added += i - pos;
        pos = i + 2; line += 1;
        fValue = value; fEnded = END_BREAK; fAdded = added;
        return;
      }
      errors.push({ code: 'stray_cr', line: rLine, row: rRow });
      value += text.slice(pos, i); added += i - pos;
      pos = i + 1;
    }
  }

  // Finishes a record: sets the width from the first record, takes the header
  // when header is true, else pads or cuts the record to the width.
  function finishRecord(fields, rLine, rRow) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: rLine, row: rRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: rLine, row: rRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) { pos += 1; line += 1; }
      else if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = (header && columns === null) ? null : rows.length;

    // Fast path: the whole record sits on one line with no quote and no CR
    // inside it (a trailing CRLF is the line break, not content). Then the
    // record is one slice split on commas. A quote anywhere before the line
    // break, or a CR inside the line, falls back to the field-by-field path.
    let e = text.indexOf('\n', pos);
    const hasLF = e !== -1;
    if (!hasLF) e = n;
    lineEnd = e;
    let segEnd = e;
    if (hasLF && e > pos && text.charCodeAt(e - 1) === CR) segEnd = e - 1;
    const iQ = text.indexOf('"', pos);
    if (segEnd > pos && (iQ === -1 || iQ >= segEnd) && crBefore(segEnd) === -1) {
      const fields = text.slice(pos, segEnd).split(',');
      pos = hasLF ? e + 1 : n;
      if (hasLF) line += 1;
      finishRecord(fields, recordLine, recordRow);
      continue;
    }

    const fields = [];
    let lastQuoted = false;

    for (;;) {
      if (text.charCodeAt(pos) === QUOTE) {
        lastQuoted = true;
        const open = pos;
        let q = text.indexOf('"', open + 1);
        let doubled = false;
        while (q !== -1 && q + 1 < n && text.charCodeAt(q + 1) === QUOTE) {
          doubled = true;
          q = text.indexOf('"', q + 2);
        }
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          scanUnquoted('"', recordLine, recordRow);
          fields.push(fValue);
          if (fEnded !== END_COMMA) break;
          continue;
        }
        // The field's content is text[open+1 .. q). Every quote in it is part
        // of a doubled pair; a CR or CRLF in it reads as one LF.
        const iCR0 = crBefore(q);
        const hasCR = iCR0 !== -1;
        const iLF0 = text.indexOf('\n', open + 1);
        const hasLF = iLF0 !== -1 && iLF0 < q;
        let value;
        if (!doubled && !hasCR) {
          value = text.slice(open + 1, q);
          if (hasLF) {
            let count = 0;
            let p = iLF0;
            while (p !== -1 && p < q) { count += 1; p = text.indexOf('\n', p + 1); }
            line += count;
          }
        } else {
          const parts = [];
          let s = open + 1;
          let seg = s;
          while (s < q) {
            const c = text.charCodeAt(s);
            if (c === QUOTE) {
              parts.push(text.slice(seg, s), '"');
              s += 2; seg = s;
            } else if (c === CR) {
              parts.push(text.slice(seg, s), '\n');
              line += 1;
              s += (s + 1 < n && text.charCodeAt(s + 1) === LF) ? 2 : 1;
              seg = s;
            } else if (c === LF) {
              line += 1;
              s += 1;
            } else {
              s += 1;
            }
          }
          parts.push(text.slice(seg, q));
          value = parts.join('');
        }
        pos = q + 1;
        if (pos >= n) { fields.push(value); break; }
        const c = text.charCodeAt(pos);
        if (c === COMMA) { pos += 1; fields.push(value); continue; }
        if (c === LF) { pos += 1; line += 1; fields.push(value); break; }
        if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
          pos += 2; line += 1; fields.push(value); break;
        }
        // What follows the closing quote is appended as it stands, up to the
        // next comma or line break; any of it is quote_junk.
        scanUnquoted(value, recordLine, recordRow);
        if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        fields.push(fValue);
        if (fEnded !== END_COMMA) break;
      } else {
        lastQuoted = false;
        scanUnquoted('', recordLine, recordRow);
        fields.push(fValue);
        if (fEnded !== END_COMMA) break;
      }
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    finishRecord(fields, recordLine, recordRow);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
