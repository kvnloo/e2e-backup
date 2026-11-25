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
  /** The most nodes one projection keeps; the rest are left out and the tree marked truncated. */
  readonly maxNodes?: number;
}

export interface Projection {
  readonly root: SemanticNode;
  /** Nodes were left out: past the node cap, or a nested document the read does not enter. */
  readonly truncated: boolean;
  /** How many secure fields the tree holds: what a screenshot must mask. */
  readonly secureCount: number;
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
  /** Device-pixel document bounds. */
  readonly bounds?: readonly number[];
}

/** Indexes the snapshot by backend DOM node id. */
function indexSnapshot(document: SnapshotDocument, strings: readonly string[]): Map<number, DomFacts> {
  const facts = new Map<number, DomFacts>();
  const ids = document.nodes.backendNodeId ?? [];
  const names = document.nodes.nodeName ?? [];
  const attributes = document.nodes.attributes ?? [];
  const inputValues = new Map<number, number>();
  const rare = document.nodes.inputValue;
  if (rare !== undefined) rare.index.forEach((node, at) => inputValues.set(node, rare.value[at]!));
  const bounds = new Map<number, readonly number[]>();
  document.layout.nodeIndex.forEach((node, at) => {
    if (!bounds.has(node)) bounds.set(node, document.layout.bounds[at]!);
  });
  ids.forEach((backendNodeId, index) => {
    const pairs = attributes[index] ?? [];
    const record: Record<string, string> = {};
    for (let at = 0; at + 1 < pairs.length; at += 2) record[(strings[pairs[at]!] ?? '').toLowerCase()] = strings[pairs[at + 1]!] ?? '';
    const input = inputValues.get(index);
    const box = bounds.get(index);
    facts.set(backendNodeId, {
      nodeName: strings[names[index]!] ?? '',
      attributes: record,
      ...(input === undefined ? {} : { inputValue: strings[input] ?? '' }),
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
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  let kept = 0;
  let truncated = false;
  let secureCount = 0;

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
      return [{ id: options.idOf(backend), text: bound(text, OBSERVED_TEXT_LIMIT, mode), states: rect === undefined || rect.width === 0 || rect.height === 0 ? { hidden: true } : {}, ...(rect === undefined ? {} : { rect }), children: [], isText: true }];
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
    if (name !== '') draft.name = bound(name, OBSERVED_NAME_LIMIT, mode);
    if (testId !== undefined) draft.testId = testId;
    const attributes = facts?.attributes ?? {};
    const secure = facts?.nodeName === 'INPUT' && attributes['type']?.toLowerCase() === 'password';
    if (secure) {
      draft.states['secure'] = true;
      secureCount += 1;
    }
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
    if (!secure && VALUE_ROLES.has(role)) {
      const typed = facts?.inputValue;
      // A text field's typed value is the input's own; a select's is the label of its chosen option, as Chromium names it.
      draft.value = bound(typed ?? stringOf(node.value) ?? '', OBSERVED_TEXT_LIMIT, mode);
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
    if (onlyText) draft.children = [];
    return [draft];
  };

  const rootNode = axNodes.find((node) => node.parentId === undefined) ?? axNodes[0];
  const children = rootNode === undefined ? [] : (rootNode.childIds ?? []).flatMap((id) => {
    const child = byId.get(id);
    return child === undefined ? [] : build(child);
  });
  const rootName = options.title ?? stringOf(rootNode?.name);
  const root: SemanticNode = {
    ref: { id: options.rootId, revision: '' },
    role: 'document',
    ...(rootName === undefined || rootName === '' ? {} : { name: bound(rootName, OBSERVED_NAME_LIMIT, mode) }),
    rect: { x: 0, y: 0, width: geometry.width, height: geometry.height },
    ...(children.length === 0 ? {} : { children: children.map(finish) }),
  };
  return { root, truncated, secureCount };
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
