/**
 * Projects one window's Chromium accessibility tree onto the engine
 * contract's semantic tree. The roles, names, values, and states are what
 * Chromium computed (`Accessibility.getFullAXTree`); the boxes, attributes,
 * and input values come from one DOM snapshot of the same document
 * (`DOMSnapshot.captureSnapshot`), joined on each node's backend DOM node id.
 * Nothing runs in the page, so an app's content security policy, its frozen
 * globals, and its mutation observers never see a read.
 *
 * Pure: the surface reads the two documents, this turns them into nodes.
 */

import { OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT, type SemanticNode } from '@e2e-dev/core/engine';

/** The fields of a Chromium `AXValue` the projection reads. */
interface AXValue {
  readonly value?: unknown;
}

/** One node of `Accessibility.getFullAXTree`, the fields the projection reads. */
export interface AXNode {
  readonly nodeId: string;
  readonly ignored: boolean;
  readonly ignoredReasons?: readonly { readonly name: string }[];
  readonly role?: AXValue;
  readonly name?: AXValue;
  readonly value?: AXValue;
  readonly properties?: readonly { readonly name: string; readonly value: AXValue }[];
  readonly parentId?: string;
  readonly childIds?: readonly string[];
  readonly backendDOMNodeId?: number;
}

/** A `DOMSnapshot` rare-string table: `value[i]` is the string index for node `index[i]`. */
interface RareStrings {
  readonly index: readonly number[];
  readonly value: readonly number[];
}

/** The fields of one `DOMSnapshot.captureSnapshot` document the projection reads. */
export interface SnapshotDocument {
  readonly nodes: {
    readonly backendNodeId?: readonly number[];
    readonly nodeName?: readonly number[];
    readonly attributes?: readonly (readonly number[])[];
    readonly inputValue?: RareStrings;
    /** A textarea's current text. */
    readonly textValue?: RareStrings;
    readonly nodeType?: readonly number[];
    readonly nodeValue?: readonly number[];
    /** The option elements that are selected. */
    readonly optionSelected?: { readonly index: readonly number[] };
    readonly parentIndex?: readonly number[];
    /** For every node inside a shadow root, that root's type: `open`, `closed`, or `user-agent`. */
    readonly shadowRootType?: RareStrings;
  };
  readonly layout: {
    readonly nodeIndex: readonly number[];
    readonly bounds: readonly (readonly number[])[];
  };
}

/** How the window's layout maps the snapshot's device pixels to the viewport's CSS pixels. */
export interface WindowGeometry {
  /** Device pixels per CSS pixel. */
  readonly scale: number;
  /** The visual viewport's scroll offset, in CSS pixels. */
  readonly scrollX: number;
  readonly scrollY: number;
  /** The viewport's size, in CSS pixels. */
  readonly width: number;
  readonly height: number;
}

/**
 * `tree` is the observation for a model: bounded fields, a few attributes,
 * each element's own text. `node` is what a locator reads: every attribute,
 * whole fields, and each element's text with its descendants'.
 */
export type ProjectionMode = 'tree' | 'node';

export interface ProjectionOptions {
  readonly mode: ProjectionMode;
  readonly testIdAttribute: string;
  /** Mints a node id from a backend DOM node id; ids carry the window, so a ref never binds in another one. */
  readonly idOf: (backendNodeId: number) => string;
  /** The root's id, stable for the surface. */
  readonly rootId: string;
  /** The document's title, the root's name. */
  readonly title?: string;
  /** Backend ids of elements a locator's CSS selector matched: kept as nodes even where the tree would leave them out. */
  readonly keep?: ReadonlySet<number>;
  /** The most nodes one projection keeps; the rest are left out and the tree marked truncated. Default 5000 for `tree`, none for `node`. */
  readonly maxNodes?: number;
}

export interface Projection {
  readonly root: SemanticNode;
  /** Nodes were left out: past the node cap, or a nested document the read does not enter. */
  readonly truncated: boolean;
}

/** Attributes an observation keeps, beside every `aria-*` one: what a model reads a control by. */
const TREE_ATTRIBUTES = new Set(['type', 'autocomplete', 'href', 'role', 'placeholder']);

/**
 * Chromium's own role names mapped to the ARIA roles `getByRole` takes, as
 * Playwright names them. A role missing here and spelled with a capital is
 * Chromium-internal and reads as a generic container.
 */
const CHROMIUM_ROLES: Readonly<Record<string, string>> = {
  image: 'img',
  MenuListPopup: 'listbox',
  MenuListOption: 'option',
  Iframe: 'iframe',
  IframePresentational: 'iframe',
  DisclosureTriangle: 'button',
  Canvas: 'img',
  Video: 'generic',
  Audio: 'generic',
};

/** Roles whose node never reaches the tree: text runs, list bullets, line breaks. */
const DROPPED_ROLES = new Set(['InlineTextBox', 'ListMarker', 'LineBreak']);

/** Containers that say nothing on their own: kept only with a name, a test id, or for a locator's `selector`. */
const GENERIC_ROLES = new Set(['generic', 'none', 'presentation', 'LabelText', 'Section', 'Pre', 'Ruby', 'Abbr', 'Mark', 'Legend', 'Unknown']);

/** Reasons Chromium leaves a node out that also hide it from a person: its subtree never reaches the tree. */
const HIDING_REASONS = new Set(['ariaHiddenElement', 'ariaHiddenSubtree', 'notRendered', 'inertElement', 'inertSubtree', 'notVisible']);

/** Roles whose value is what a person typed or picked. */
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);

const DEFAULT_MAX_NODES = 5000;

/** One DOM node's facts from the snapshot. */
interface DomFacts {
  readonly nodeName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly inputValue?: string;
  /** A textarea's current text. */
  readonly textValue?: string;
  /** Whether the node's text content holds anything but white space, as `textContent` reads it. */
  readonly hasText: boolean;
  /** A select's value: what its first selected option submits. */
  readonly selectValue?: string;
  /** Device-pixel document bounds. */
  readonly bounds?: readonly number[];
}

/**
 * Each select's value, by node index: what its first selected option submits,
 * the option's `value` attribute or else its text, as `HTMLSelectElement.value`
 * reads it.
 */
function selectedValues(document: SnapshotDocument, strings: readonly string[], attributesOf: (index: number) => Record<string, string>): Map<number, string> {
  const values = new Map<number, string>();
  const selected = document.nodes.optionSelected?.index ?? [];
  if (selected.length === 0) return values;
  const names = document.nodes.nodeName ?? [];
  const parents = document.nodes.parentIndex ?? [];
  const types = document.nodes.nodeType ?? [];
  const nodeValues = document.nodes.nodeValue ?? [];
  const texts = new Map<number, string>();
  types.forEach((type, index) => {
    if (type !== 3) return;
    const parent = parents[index] ?? -1;
    texts.set(parent, (texts.get(parent) ?? '') + (strings[nodeValues[index]!] ?? ''));
  });
  for (const option of selected.toSorted((a, b) => a - b)) {
    let select = parents[option] ?? -1;
    while (select >= 0 && strings[names[select]!] !== 'SELECT') select = parents[select] ?? -1;
    if (select < 0 || values.has(select)) continue;
    values.set(select, attributesOf(option)['value'] ?? collapse(texts.get(option) ?? ''));
  }
  return values;
}

/** The node indices whose text content holds anything but white space: every ancestor of such a text node. */
function nodesWithText(document: SnapshotDocument, strings: readonly string[]): Set<number> {
  const marked = new Set<number>();
  const parents = document.nodes.parentIndex ?? [];
  const values = document.nodes.nodeValue ?? [];
  (document.nodes.nodeType ?? []).forEach((type, index) => {
    if (type !== 3 || (strings[values[index]!] ?? '').trim() === '') return;
    for (let at = parents[index] ?? -1; at >= 0 && !marked.has(at); at = parents[at] ?? -1) marked.add(at);
  });
  return marked;
}

/** Indexes the snapshot by backend DOM node id. */
function indexSnapshot(document: SnapshotDocument, strings: readonly string[]): Map<number, DomFacts> {
  const facts = new Map<number, DomFacts>();
  const ids = document.nodes.backendNodeId ?? [];
  const names = document.nodes.nodeName ?? [];
  const attributes = document.nodes.attributes ?? [];
  const rareStrings = (rare: RareStrings | undefined): Map<number, string> => {
    const values = new Map<number, string>();
    rare?.index.forEach((node, at) => values.set(node, strings[rare.value[at]!] ?? ''));
    return values;
  };
  const inputValues = rareStrings(document.nodes.inputValue);
  const textValues = rareStrings(document.nodes.textValue);
  const withText = nodesWithText(document, strings);
  const bounds = new Map<number, readonly number[]>();
  document.layout.nodeIndex.forEach((node, at) => {
    if (!bounds.has(node)) bounds.set(node, document.layout.bounds[at]!);
  });
  const attributesOf = (index: number): Record<string, string> => {
    const pairs = attributes[index] ?? [];
    const record: Record<string, string> = {};
    for (let at = 0; at + 1 < pairs.length; at += 2) record[(strings[pairs[at]!] ?? '').toLowerCase()] = strings[pairs[at + 1]!] ?? '';
    return record;
  };
  const selectValues = selectedValues(document, strings, attributesOf);
  ids.forEach((backendNodeId, index) => {
    const input = inputValues.get(index);
    const text = textValues.get(index);
    const selected = selectValues.get(index);
    const box = bounds.get(index);
    facts.set(backendNodeId, {
      nodeName: strings[names[index]!] ?? '',
      attributes: attributesOf(index),
      hasText: withText.has(index),
      ...(input === undefined ? {} : { inputValue: input }),
      ...(text === undefined ? {} : { textValue: text }),
      ...(selected === undefined ? {} : { selectValue: selected }),
      ...(box === undefined ? {} : { bounds: box }),
    });
  });
  return facts;
}

/** A node under construction: the contract node's fields, mutable, with the text the projection folds. */
interface Draft {
  id: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  testId?: string;
  inputPurpose?: SemanticNode['inputPurpose'];
  states: Record<string, boolean>;
  level?: number;
  attributes?: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
  children: Draft[];
  /** A text run: its text folds into the parent when it is the parent's only content. */
  isText: boolean;
}

/** `value` cut at `limit` in tree mode, whole in node mode. */
function bound(value: string, limit: number, mode: ProjectionMode): string {
  return mode === 'tree' && value.length > limit ? value.slice(0, limit) : value;
}

function stringOf(value: AXValue | undefined): string | undefined {
  const raw = value?.value;
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === 'string' ? raw : String(raw);
}

/** Origin and path of a link: query strings and fragments routinely carry tokens, so an observation never shows them. */
function originAndPath(href: string): string {
  if (!URL.canParse(href)) return href.replace(/[?#].*$/, '');
  const url = new URL(href);
  return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}` : `${url.protocol}${url.pathname}`;
}

/** Collapses runs of white space the way rendered text reads. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The text a node reads as: its text runs, and in node mode its descendants' too. */
function textOf(draft: Draft, deep: boolean): string {
  const parts: string[] = [];
  const walk = (node: Draft): void => {
    for (const child of node.children) {
      if (child.isText) parts.push(child.text ?? '');
      else if (deep) {
        if (child.children.length === 0 && child.text !== undefined) parts.push(child.text);
        else walk(child);
      }
    }
  };
  walk(draft);
  return collapse(parts.join(' '));
}

/**
 * Projects the window's accessibility tree. Returns the root and how many
 * secure fields it holds; a field is secure while it is a password input,
 * and then reports no value and no text.
 */
export function projectTree(axNodes: readonly AXNode[], document: SnapshotDocument, strings: readonly string[], geometry: WindowGeometry, options: ProjectionOptions): Projection {
  const { mode, testIdAttribute } = options;
  const byId = new Map(axNodes.map((node) => [node.nodeId, node]));
  const dom = indexSnapshot(document, strings);
  // The cap bounds what a model reads; a locator reads every node, or it would miss a match past the cap.
  const maxNodes = options.maxNodes ?? (mode === 'tree' ? DEFAULT_MAX_NODES : Number.POSITIVE_INFINITY);
  let kept = 0;
  let truncated = false;
  const drafted = new Map<number, Draft>();

  const rectOf = (facts: DomFacts | undefined): Draft['rect'] => {
    const box = facts?.bounds;
    if (box === undefined || box.length < 4) return undefined;
    const [x, y, width, height] = box as [number, number, number, number];
    return { x: x / geometry.scale - geometry.scrollX, y: y / geometry.scale - geometry.scrollY, width: width / geometry.scale, height: height / geometry.scale };
  };

  const build = (node: AXNode): Draft[] => {
    if (node.ignored && node.ignoredReasons?.some((reason) => HIDING_REASONS.has(reason.name)) === true) return [];
    const chromium = stringOf(node.role) ?? '';
    if (DROPPED_ROLES.has(chromium)) return [];
    const children = (): Draft[] => (node.childIds ?? []).flatMap((id) => {
      const child = byId.get(id);
      return child === undefined ? [] : build(child);
    });
    const backend = node.backendDOMNodeId;
    const facts = backend === undefined ? undefined : dom.get(backend);
    if (chromium === 'StaticText') {
      const text = collapse(stringOf(node.name) ?? '');
      if (text === '' || backend === undefined) return [];
      if (kept >= maxNodes) {
        truncated = true;
        return [];
      }
      kept += 1;
      const rect = rectOf(facts);
      const run: Draft = { id: options.idOf(backend), text: bound(text, OBSERVED_TEXT_LIMIT, mode), states: rect === undefined || rect.width === 0 || rect.height === 0 ? { hidden: true } : {}, ...(rect === undefined ? {} : { rect }), children: [], isText: true };
      drafted.set(backend, run);
      return [run];
    }
    const testId = facts?.attributes[testIdAttribute.toLowerCase()];
    const name = collapse(stringOf(node.name) ?? '');
    const role = CHROMIUM_ROLES[chromium] ?? (/^[A-Z]/.test(chromium) ? 'generic' : chromium);
    // A container Chromium leaves out, or one that says nothing, gives its place to its children: unless a test id,
    // a name, or a locator's selector makes it addressable.
    const silent = node.ignored || GENERIC_ROLES.has(chromium) || role === 'generic';
    const selected = backend !== undefined && options.keep?.has(backend) === true;
    if (silent && testId === undefined && !selected && (node.ignored || name === '')) return children();
    if (backend === undefined) return children();
    if (role === 'iframe') truncated = true;
    if (kept >= maxNodes) {
      truncated = true;
      return [];
    }
    kept += 1;
    const draft: Draft = { id: options.idOf(backend), role: silent ? 'generic' : role, states: {}, children: [], isText: false };
    drafted.set(backend, draft);
    if (name !== '') draft.name = bound(name, OBSERVED_NAME_LIMIT, mode);
    if (testId !== undefined) draft.testId = testId;
    const attributes = facts?.attributes ?? {};
    const secure = facts?.nodeName === 'INPUT' && attributes['type']?.toLowerCase() === 'password';
    if (secure) draft.states['secure'] = true;
    const autocomplete = attributes['autocomplete']?.toLowerCase();
    if (secure || autocomplete === 'current-password' || autocomplete === 'new-password') draft.inputPurpose = 'password';
    else if (autocomplete === 'username') draft.inputPurpose = 'username';
    else if (autocomplete === 'one-time-code') draft.inputPurpose = 'one-time-code';
    for (const property of node.properties ?? []) {
      const value = property.value.value;
      switch (property.name) {
        case 'checked':
        case 'pressed':
          draft.states[property.name] = value === 'true' || value === true;
          break;
        case 'disabled':
        case 'expanded':
        case 'selected':
        case 'focused':
        case 'readonly':
          draft.states[property.name] = value === true || value === 'true';
          break;
        case 'level':
          if (role === 'heading' && typeof value === 'number') draft.level = value;
          break;
      }
    }
    const checkable = facts?.nodeName === 'INPUT' && ['checkbox', 'radio'].includes(attributes['type']?.toLowerCase() ?? '');
    if (facts?.nodeName === 'SELECT') {
      // A select's value is what its chosen option submits, as `select.value` reads it; its options name the labels.
      draft.value = bound(facts.selectValue ?? '', OBSERVED_TEXT_LIMIT, mode);
    } else if (checkable) {
      // A checkbox or radio submits its value attribute, `on` without one, whatever its state; an observation leaves that token out.
      if (mode === 'node') draft.value = attributes['value'] ?? 'on';
    } else if (!secure && (facts?.nodeName === 'INPUT' || facts?.nodeName === 'TEXTAREA')) {
      // A field's value is the element's own, whatever role Chromium gives it (a date input is no textbox).
      draft.value = bound((facts.nodeName === 'INPUT' ? facts.inputValue : facts.textValue) ?? '', OBSERVED_TEXT_LIMIT, mode);
    } else if (!secure && VALUE_ROLES.has(role)) {
      // An editing host or an ARIA widget has no DOM value: its value is the one Chromium computes.
      draft.value = bound(stringOf(node.value) ?? '', OBSERVED_TEXT_LIMIT, mode);
    }
    const shown: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (secure && key === 'value') continue;
      if (mode === 'tree' && !TREE_ATTRIBUTES.has(key) && !key.startsWith('aria-')) continue;
      shown[key] = mode === 'tree' && key === 'href' ? originAndPath(value) : bound(value, OBSERVED_TEXT_LIMIT, mode);
    }
    if (Object.keys(shown).length > 0) draft.attributes = shown;
    const rect = rectOf(facts);
    if (rect !== undefined) draft.rect = rect;
    if (rect === undefined || rect.width === 0 || rect.height === 0) draft.states['hidden'] = true;
    // A field's inner editor repeats its value as text: a secure one would leak its length, any other says nothing new.
    draft.children = secure || role === 'textbox' || role === 'searchbox' ? [] : children();
    // Text runs that are the node's only content are the node's text, not nodes of their own. Beside other
    // children they stay nodes, and an observation does not repeat them on the node; a locator reads all of it.
    const onlyText = draft.children.length > 0 && draft.children.every((child) => child.isText);
    if (!secure && (mode === 'node' || onlyText)) {
      const text = textOf(draft, mode === 'node');
      if (text !== '') draft.text = bound(text, OBSERVED_TEXT_LIMIT, mode);
    }
    // A locator keeps several runs as nodes, so an exact text query finds each one (`<span>Price</span> <span>$10</span>`).
    if (onlyText && (mode === 'tree' || draft.children.length === 1)) draft.children = [];
    // What toBeEmpty reads, on a locator's read only and never on a secure field: a field by its value, anything else
    // by its text content, as the web engine reads it (a select's option text counts, and so does hidden text).
    if (mode === 'node' && !secure) {
      const field = facts?.nodeName === 'INPUT' || facts?.nodeName === 'TEXTAREA';
      draft.states['empty'] = field ? (draft.value ?? '') === '' : facts?.hasText !== true;
    }
    return [draft];
  };

  const rootNode = axNodes.find((node) => node.parentId === undefined) ?? axNodes[0];
  const children = rootNode === undefined ? [] : (rootNode.childIds ?? []).flatMap((id) => {
    const child = byId.get(id);
    return child === undefined ? [] : build(child);
  });
  // An element a locator's selector matched that the tree leaves out (`hidden`, `display: none`) is still there to
  // count: it joins the tree as a hidden node under its nearest ancestor that did.
  for (const backend of options.keep ?? []) {
    if (drafted.has(backend)) continue;
    const facts = dom.get(backend);
    if (facts === undefined) continue;
    const testId = facts.attributes[testIdAttribute.toLowerCase()];
    const absent: Draft = {
      id: options.idOf(backend),
      role: 'generic',
      states: { hidden: true },
      children: [],
      isText: false,
      ...(testId === undefined ? {} : { testId }),
      ...(Object.keys(facts.attributes).length === 0 ? {} : { attributes: { ...facts.attributes } }),
    };
    const parent = ancestorOf(backend, drafted, document);
    (parent === undefined ? children : parent.children).push(absent);
    drafted.set(backend, absent);
  }
  const rootName = options.title ?? stringOf(rootNode?.name);
  const root: SemanticNode = {
    ref: { id: options.rootId, revision: '' },
    role: 'document',
    ...(rootName === undefined || rootName === '' ? {} : { name: bound(rootName, OBSERVED_NAME_LIMIT, mode) }),
    rect: { x: 0, y: 0, width: geometry.width, height: geometry.height },
    ...(children.length === 0 ? {} : { children: children.map(finish) }),
  };
  return { root, truncated };
}

/** Elements a screenshot paints over: a secure field's value, or a nested document the engine does not read. */
const MASKED_TAGS = new Set(['IFRAME', 'FRAME', 'WEBVIEW']);

/**
 * How many rendered elements a screenshot must paint over and a selector
 * cannot reach: password inputs and nested documents inside a closed shadow
 * root, at any depth. Read from the DOM snapshot, which enters every shadow
 * root, so it holds whatever the accessibility tree leaves out (`aria-hidden`,
 * the node cap). Every other such element in the document, open shadow roots
 * included, a selector mask covers.
 */
export function unmaskableCount(document: SnapshotDocument, strings: readonly string[]): number {
  const names = document.nodes.nodeName ?? [];
  const parents = document.nodes.parentIndex ?? [];
  const attributes = document.nodes.attributes ?? [];
  const closed = new Set<number>();
  const rare = document.nodes.shadowRootType;
  rare?.index.forEach((node, at) => {
    if (strings[rare.value[at]!] === 'closed') closed.add(node);
  });
  if (closed.size === 0) return 0;
  const rendered = new Set(document.layout.nodeIndex);
  let count = 0;
  names.forEach((nameIndex, node) => {
    if (!rendered.has(node)) return;
    const name = strings[nameIndex] ?? '';
    const pairs = attributes[node] ?? [];
    let password = false;
    for (let at = 0; at + 1 < pairs.length; at += 2) {
      if ((strings[pairs[at]!] ?? '').toLowerCase() === 'type' && (strings[pairs[at + 1]!] ?? '').toLowerCase() === 'password') password = true;
    }
    if (!(name === 'INPUT' && password) && !MASKED_TAGS.has(name)) return;
    for (let at: number | undefined = node; at !== undefined && at >= 0; at = parents[at]) {
      if (closed.has(at)) {
        count += 1;
        return;
      }
    }
  });
  return count;
}

/** The nearest DOM ancestor of a node that has a draft, or undefined when none does (the node sits under the root). */
function ancestorOf(backend: number, drafted: ReadonlyMap<number, Draft>, document: SnapshotDocument): Draft | undefined {
  const ids = document.nodes.backendNodeId ?? [];
  const parents = document.nodes.parentIndex ?? [];
  for (let at = parents[ids.indexOf(backend)] ?? -1; at >= 0; at = parents[at] ?? -1) {
    const draft = drafted.get(ids[at]!);
    if (draft !== undefined && !draft.isText) return draft;
  }
  return undefined;
}

/** A draft as a contract node, empty fields left out. */
function finish(draft: Draft): SemanticNode {
  return {
    ref: { id: draft.id, revision: '' },
    ...(draft.role === undefined ? {} : { role: draft.role }),
    ...(draft.name === undefined ? {} : { name: draft.name }),
    ...(draft.text === undefined ? {} : { text: draft.text }),
    ...(draft.value === undefined ? {} : { value: draft.value }),
    ...(draft.testId === undefined ? {} : { testId: draft.testId }),
    ...(draft.inputPurpose === undefined ? {} : { inputPurpose: draft.inputPurpose }),
    ...(Object.keys(draft.states).length === 0 ? {} : { states: draft.states }),
    ...(draft.level === undefined ? {} : { level: draft.level }),
    ...(draft.attributes === undefined ? {} : { attributes: draft.attributes }),
    ...(draft.rect === undefined ? {} : { rect: draft.rect }),
    ...(draft.children.length === 0 ? {} : { children: draft.children.map(finish) }),
  };
}
