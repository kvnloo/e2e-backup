/**
 * Where a screen is, as a route rather than a URL.
 *
 * The replay precondition asks "is the app on the screen this recording
 * began on", and the postcondition "did we land where the recording landed".
 * A URL answers neither directly: it carries the id the app minted for this
 * run's record, a cache buster, a session token, a fragment. All of that
 * changes between two visits to the same screen, and none of it is the
 * screen.
 *
 * So a location is reduced to its route: the origin it is on, the pathname's
 * segments, and the query's parameters, with every segment or parameter
 * value that looks minted per record (a uuid, a hex or digit run, a long
 * token mixing letters and digits, a prefixed record id, text with
 * whitespace) replaced by `:id`.
 * Every other query value is part of the screen: `?mode=unsafe` is not
 * `?mode=safe`, and `?tab=notes` shows other controls than no tab. The
 * fragment is dropped, except that an app routing in the fragment
 * (`#/companies/1`) routes by that path and its query. A value the call
 * marked with `unique()` needs no rule here: the recording spells it as a
 * placeholder in every spelling a URL gives it, its slug included
 * (`cache/template.ts`), and replay fills in this run's value on both sides.
 *
 * The origin is relative to the app (`appLocation`): a location on the app's
 * own origin is kept as its path, so a recording made against one deployment
 * of the app replays on another that shares its `app.identity`, while a
 * screen on any other origin keeps its origin and is another route.
 *
 * Two routes are the same screen only when they read alike. A literal that
 * differs, a slug the runner never saw the value of, is another screen at
 * both ends of a step: nothing recorded can tell a record's slug from a
 * route word, and a screen that looks alike on another route (a settings
 * page and a profile page sharing one layout) is exactly where a wrong link
 * lands. A device engine reports a screen title in place of a URL, which is
 * already a route and compares as itself.
 */

type Route =
  | {
      readonly kind: 'url';
      /** The origin, absent for a location on the app's own origin (`appLocation`). */
      readonly origin?: string;
      readonly segments: readonly string[];
      /** One `[key, value]` pair per query parameter, minted keys and values as `:id`, sorted. */
      readonly query: readonly (readonly [string, string])[];
    }
  | { readonly kind: 'opaque'; readonly location: string };

const PARAM = ':id';

/**
 * A segment shaped like a value the app mints per record: a uuid, a hex or
 * digit run, a long token carrying letters and at least two digits (a route
 * word such as `companies-v2` has one), a prefixed record id (letters, a
 * dash, then a digit tail of two or more: `PROJ-016`, `INV-2041`; a single
 * digit as in `page-2` is a route word), or text with whitespace, which no
 * router puts in a path. Any other capitalized or dashed word is none of
 * these.
 */
const MINTED_SEGMENT: readonly RegExp[] = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{8,}$/i,
  /^\d+$/,
  /^(?=(?:[^\d]*\d){2})(?=.*[A-Za-z])[A-Za-z0-9_-]{12,}$/,
  /^[A-Za-z]+-\d{2,}$/,
  /\s/,
];

/**
 * A query value is minted on the same rules, with the wider alphabet a
 * value carries that a path segment cannot: a signed token or a timestamp
 * (`eyJhbGciOi.x1.y2`, `2026-10-01T10:00:00Z`) has dots, colons, and base64,
 * and a date (`?from=2026-10-01`, a default an app fills in with today) has
 * no letter at all.
 */
const MINTED_VALUE: readonly RegExp[] = [
  ...MINTED_SEGMENT,
  /^(?=(?:[^\d]*\d){2})(?=.*[A-Za-z])[\w.~+/=:-]{12,}$/,
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
];

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * A location as the cache compares it: a URL on the app's own origin as its
 * path, query, and fragment, so a recording follows the app to another
 * deployment of it; anything else (another origin, a device screen title)
 * as it is.
 */
export function appLocation(location: string, appOrigin: string | undefined): string {
  if (appOrigin === undefined || !URL.canParse(location)) return location;
  const url = new URL(location);
  return url.origin === appOrigin ? `${url.pathname}${url.search}${url.hash}` : location;
}

/** Scheme and authority as a URL parser skips them: leading whitespace and any run of slashes. */
const URL_ORIGIN_PREFIX = /^\s*[a-z][a-z\d+.-]*:[/\\]*[^/?#\\]*/i;

/**
 * A navigation as a recording keeps it: a URL on the app's origin without
 * that origin, the rest as typed. Anything else stays as given, and so does
 * a URL with credentials or a rest that would not open the same URL.
 */
export function appNavigation(url: string, appOrigin: string | undefined): string {
  if (appOrigin === undefined || !URL.canParse(url)) return url;
  const parsed = new URL(url);
  if (parsed.origin !== appOrigin || parsed.username !== '' || parsed.password !== '') return url;
  const prefix = URL_ORIGIN_PREFIX.exec(url)?.[0];
  if (prefix === undefined) return url;
  const rest = url.slice(prefix.length);
  const path = rest.startsWith('/') ? rest : `/${rest}`;
  return URL.canParse(path, appOrigin) && new URL(path, appOrigin).href === parsed.href ? path : url;
}

/**
 * The parts of a location its route is made of, or undefined when the
 * location is not a web address (a device engine's screen title, a
 * browser's own page).
 */
function locationParts(location: string): { readonly origin?: string; readonly pathname: string; readonly search: string } | undefined {
  let origin: string | undefined;
  let rest = location;
  if (URL.canParse(location)) {
    const url = new URL(location);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    origin = url.origin;
    rest = `${url.pathname}${url.search}${url.hash}`;
  } else if (!location.startsWith('/')) {
    return undefined;
  }
  const hashAt = rest.indexOf('#');
  const fragment = hashAt === -1 ? '' : rest.slice(hashAt + 1);
  const [documentPath, documentSearch] = splitOnce(hashAt === -1 ? rest : rest.slice(0, hashAt), '?');
  if (!fragment.startsWith('/')) return { ...(origin === undefined ? {} : { origin }), pathname: documentPath, search: documentSearch };
  const [fragmentPath, fragmentSearch] = splitOnce(fragment, '?');
  return {
    ...(origin === undefined ? {} : { origin }),
    pathname: fragmentPath,
    search: [documentSearch, fragmentSearch].filter((part) => part !== '').join('&'),
  };
}

function splitOnce(text: string, separator: string): readonly [string, string] {
  const at = text.indexOf(separator);
  return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
}

/**
 * A query's parameters as `[key, value]` pairs, sorted; with `mint`, a
 * minted key or value as `:id`.
 */
function queryPairs(search: string, mint: boolean): (readonly [string, string])[] {
  const minted = (text: string) => mint && text !== '' && MINTED_VALUE.some((pattern) => pattern.test(text));
  const pairs: (readonly [string, string])[] = [];
  for (const [key, value] of new URLSearchParams(search)) pairs.push([minted(key) ? PARAM : key, minted(value) ? PARAM : value]);
  return pairs.toSorted(([a, x], [b, y]) => (a === b ? compareText(x, y) : compareText(a, b)));
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The route of a location. With `mint`, every segment and query value
 * shaped like one the app mints per record reads `:id`; without, the
 * location's own words are kept, decoded, its fragment dropped as above.
 */
function routeOf(location: string, mint = true): Route {
  const parts = locationParts(location);
  if (parts === undefined) return { kind: 'opaque', location };
  const segments = parts.pathname
    .split('/')
    .filter((raw) => raw !== '')
    .map((raw) => {
      const text = decodeSegment(raw);
      return mint && MINTED_SEGMENT.some((pattern) => pattern.test(text)) ? PARAM : text;
    });
  return { kind: 'url', ...(parts.origin === undefined ? {} : { origin: parts.origin }), segments, query: queryPairs(parts.search, mint) };
}

/** Whether two locations name the same screen: one origin, and segments and query that read alike. */
export function sameRoute(recorded: string, live: string): boolean {
  return routeIdentity(routeOf(recorded)) === routeIdentity(routeOf(live));
}

/**
 * A location's address as one string, nothing read as minted: two
 * locations have equal keys only when they name the same record too
 * (`/orders/123/edit` is not `/orders/456/edit`). The fragment is dropped
 * as a route drops it, and the query's order does not count.
 */
export function addressKey(location: string): string {
  return routeIdentity(routeOf(location, false));
}

/**
 * A location as a recording keeps it: spelled as its route, each segment
 * and query value the app minted per record as `:id`, so a token, a code,
 * or a record id a URL carried mid-flow (a magic link, an OAuth callback)
 * is never written to an entry or a report. A device screen title, or any
 * other location that is not a web address, is kept as it is.
 */
export function routeLocation(location: string): string {
  const route = routeOf(location);
  if (route.kind === 'opaque') return route.location;
  const spell = (text: string) => (text === PARAM ? text : encodeURIComponent(text));
  const path = `/${route.segments.map(spell).join('/')}`;
  const query = route.query.map(([key, value]) => `${spell(key)}=${spell(value)}`).join('&');
  return `${route.origin ?? ''}${path}${query === '' ? '' : `?${query}`}`;
}

/** A route's parts as one comparable string, a slash inside a segment kept inside it. */
function routeIdentity(route: Route): string {
  return JSON.stringify(route.kind === 'opaque' ? [route.location] : [route.origin ?? null, route.segments, route.query]);
}
