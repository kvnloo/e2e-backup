import { readFileSync } from 'node:fs';
import { resolveExpression, type SemanticNode } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { projectTree, unmaskableCount, type AXNode, type ProjectionMode, type SnapshotDocument } from '../../src/tree.ts';

/**
 * One read of the testbed's sign-in window, captured from Electron 45 with
 * the username and password filled and the page scrolled by 59.5 CSS pixels
 * on a 2x display: the accessibility tree, the DOM snapshot, and the layout
 * metrics, as the surface reads them.
 */
const captured = JSON.parse(readFileSync(new URL('../fixtures/sign-in.json', import.meta.url), 'utf8')) as {
  ax: AXNode[];
  snapshot: { documents: SnapshotDocument[]; strings: string[] };
  metrics: { layoutViewport: { clientWidth: number }; cssLayoutViewport: { clientWidth: number }; cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } };
};

function project(mode: ProjectionMode, extra: { maxNodes?: number; keep?: ReadonlySet<number> } = {}) {
  const { metrics } = captured;
  return projectTree(
    captured.ax,
    captured.snapshot.documents[0]!,
    captured.snapshot.strings,
    {
      scale: metrics.layoutViewport.clientWidth / metrics.cssLayoutViewport.clientWidth,
      scrollX: metrics.cssVisualViewport.pageX,
      scrollY: metrics.cssVisualViewport.pageY,
      width: metrics.cssVisualViewport.clientWidth,
      height: metrics.cssVisualViewport.clientHeight,
    },
    { mode, testIdAttribute: 'data-testid', idOf: (id) => `1.${id}`, rootId: 'window', title: 'Sign In', ...extra },
  );
}

function all(root: SemanticNode): SemanticNode[] {
  return [root, ...(root.children ?? []).flatMap(all)];
}

function find(root: SemanticNode, predicate: (node: SemanticNode) => boolean): SemanticNode {
  const node = all(root).find(predicate);
  if (node === undefined) throw new Error('no such node');
  return node;
}

describe('projectTree', () => {
  it('names the root after the document and sizes it to the viewport', () => {
    const { root } = project('tree');
    expect(root.ref).toEqual({ id: 'window', revision: '' });
    expect(root.role).toBe('document');
    expect(root.name).toBe('Sign In');
    expect(root.rect).toEqual({ x: 0, y: 0, width: 640, height: 688 });
  });

  it('reports a password field as secure, with no value and no text', () => {
    const { root } = project('node');
    const password = find(root, (node) => node.testId === 'password');
    expect(password.states?.secure).toBe(true);
    expect(password.value).toBeUndefined();
    expect(password.text).toBeUndefined();
    expect(password.children).toBeUndefined();
    expect(password.inputPurpose).toBe('password');
    expect(JSON.stringify(root)).not.toContain('hunter2');
    expect(JSON.stringify(root)).not.toContain('•');
  });

  it('reads a text field value from the DOM and a select from its chosen option', () => {
    const { root } = project('tree');
    const username = find(root, (node) => node.testId === 'username');
    expect(username).toMatchObject({ role: 'textbox', name: 'Username', value: 'ada', inputPurpose: 'username', attributes: { placeholder: 'ada', autocomplete: 'username' } });
    expect(find(root, (node) => node.testId === 'plan')).toMatchObject({ role: 'combobox', name: 'Plan', value: 'Pro' });
  });

  it('reports empty for a locator only: a field by its value, anything else by its text', () => {
    const node = project('node').root;
    expect(find(node, (candidate) => candidate.testId === 'username').states?.empty).toBe(false);
    expect(find(node, (candidate) => candidate.testId === 'status').states?.empty).toBe(false);
    expect(find(node, (candidate) => candidate.testId === 'password').states?.empty).toBeUndefined();
    expect(find(project('tree').root, (candidate) => candidate.testId === 'username').states?.empty).toBeUndefined();
  });

  it('reads a checkbox value for a locator only, as the value attribute or on', () => {
    expect(find(project('node').root, (node) => node.role === 'checkbox').value).toBe('on');
    expect(find(project('tree').root, (node) => node.role === 'checkbox').value).toBeUndefined();
  });

  it('maps boxes from device pixels in the document to CSS pixels in the viewport', () => {
    const { root } = project('tree');
    const add = find(root, (node) => node.role === 'button' && node.name === 'Add one');
    // Playwright measured the same button at x 24, y 339.1171875, 65.6640625 by 21.5 in this scroll position.
    expect(add.rect).toEqual({ x: 24, y: 339.1171875, width: 65.6640625, height: 21.5 });
  });

  it('folds a text run that is the only content into its node, and keeps runs beside other children as nodes', () => {
    const { root } = project('tree');
    const signIn = find(root, (node) => node.role === 'button' && node.name === 'Sign in');
    expect(signIn.text).toBe('Sign in');
    expect(signIn.children).toBeUndefined();
    const form = find(root, (node) => node.role === 'form');
    expect(form.text).toBeUndefined();
    expect(form.children?.filter((child) => child.role === undefined).map((child) => child.text)).toEqual(['Username', 'Password', 'Plan']);
  });

  it('gives a locator the text of a node with its descendants', () => {
    const { root } = project('node');
    const counter = find(root, (node) => node.role === 'region' && node.name === 'Counter');
    expect(counter.text).toBe('Counter Add one 0');
  });

  it('keeps every attribute for a locator and only the model-facing ones in an observation', () => {
    const tree = find(project('tree').root, (node) => node.testId === 'username');
    const node = find(project('node').root, (candidate) => candidate.testId === 'username');
    expect(Object.keys(tree.attributes ?? {}).toSorted()).toEqual(['autocomplete', 'placeholder']);
    expect(node.attributes).toMatchObject({ name: 'username', 'data-testid': 'username', placeholder: 'ada' });
  });

  it('reads headings with their level and checkbox states', () => {
    const { root } = project('tree');
    expect(find(root, (node) => node.role === 'heading' && node.name === 'Counter').level).toBe(2);
    expect(find(root, (node) => node.role === 'checkbox').states).toMatchObject({ checked: false });
  });

  it('marks nodes with no box hidden, such as the options of a closed select', () => {
    const { root } = project('tree');
    const option = find(root, (node) => node.role === 'option' && node.name === 'Team');
    expect(option.states?.hidden).toBe(true);
  });

  it('answers the contract locator semantics through resolveExpression', () => {
    const { root } = project('node');
    const byRole = resolveExpression({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, name: { kind: 'string', value: 'Sign in', exact: true } } }, [root]);
    expect(byRole.map((node) => node.testId)).toEqual(['sign-in']);
    const byText = resolveExpression({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'Not signed in', exact: true } } }, [root]);
    expect(byText.map((node) => node.testId)).toEqual(['status']);
    const byPlaceholder = resolveExpression({ kind: 'query', query: { kind: 'placeholder', value: { kind: 'string', value: 'ada', exact: true } } }, [root]);
    expect(byPlaceholder.map((node) => node.testId)).toEqual(['username']);
  });

  it('keeps a container a locator selected, which the tree would leave out', () => {
    const label = captured.ax.find((node) => node.role?.value === 'LabelText')!;
    const id = `1.${label.backendDOMNodeId}`;
    expect(all(project('node').root).some((node) => node.ref.id === id)).toBe(false);
    const kept = find(project('node', { keep: new Set([label.backendDOMNodeId!]) }).root, (node) => node.ref.id === id);
    expect(kept).toMatchObject({ role: 'generic', text: 'Username' });
    expect(kept.children?.map((child) => child.testId ?? child.text)).toEqual(['Username', 'username']);
  });

  it('caps an observation and never a locator read', () => {
    const buttons = Array.from({ length: 6000 }, (_, at) => at + 2);
    const ax: AXNode[] = [
      { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, childIds: buttons.map(String), backendDOMNodeId: 1 },
      ...buttons.map((id) => ({ nodeId: String(id), ignored: false, role: { value: 'button' }, name: { value: `Button ${id}` }, parentId: '1', backendDOMNodeId: id })),
    ];
    const empty: SnapshotDocument = { nodes: {}, layout: { nodeIndex: [], bounds: [] } };
    const geometry = { scale: 1, scrollX: 0, scrollY: 0, width: 640, height: 480 };
    const options = { testIdAttribute: 'data-testid', idOf: (id: number) => `1.${id}`, rootId: 'window' };
    const observed = projectTree(ax, empty, [], geometry, { ...options, mode: 'tree' });
    expect(observed.truncated).toBe(true);
    expect(observed.root.children).toHaveLength(5000);
    const located = projectTree(ax, empty, [], geometry, { ...options, mode: 'node' });
    expect(located.truncated).toBe(false);
    expect(located.root.children).toHaveLength(6000);
  });

  it('stops at the node cap and says the tree is incomplete', () => {
    const capped = project('tree', { maxNodes: 10 });
    expect(capped.truncated).toBe(true);
    expect(all(capped.root).length).toBeLessThanOrEqual(11);
    expect(project('tree').truncated).toBe(false);
  });
});

describe('unmaskableCount', () => {
  // strings: 0 '#document', 1 'BODY', 2 'DIV', 3 'INPUT', 4 'type', 5 'password', 6 'closed', 7 'open', 8 'IFRAME', 9 'text'
  const strings = ['#document', 'BODY', 'DIV', 'INPUT', 'type', 'password', 'closed', 'open', 'IFRAME', 'text'];

  /** A document of `#document > BODY > DIV(host) > child`, the child inside a shadow root of the given type, laid out or not. */
  function documentWith(child: { name: number; attributes?: number[]; shadow?: number; rendered?: boolean; nested?: number }): SnapshotDocument {
    const names = [0, 1, 2, child.name];
    const parents = [-1, 0, 1, 2];
    const shadow = { index: [] as number[], value: [] as number[] };
    if (child.nested === undefined) {
      if (child.shadow !== undefined) {
        shadow.index.push(3);
        shadow.value.push(child.shadow);
      }
    } else {
      // The child sits in a shadow root of its own (`nested`), under a host that is itself inside a `shadow` root.
      names.splice(3, 0, 2);
      parents.push(3);
      shadow.index.push(3, 4);
      shadow.value.push(child.shadow!, child.nested);
    }
    const last = names.length - 1;
    return {
      nodes: { nodeName: names, parentIndex: parents, attributes: names.map((_, at) => (at === last ? (child.attributes ?? []) : [])), shadowRootType: shadow },
      layout: { nodeIndex: child.rendered === false ? [0, 1, 2] : names.map((_, at) => at), bounds: [] },
    };
  }

  it('counts a rendered password field or nested document inside a closed shadow root', () => {
    expect(unmaskableCount(documentWith({ name: 3, attributes: [4, 5], shadow: 6 }), strings)).toBe(1);
    expect(unmaskableCount(documentWith({ name: 8, shadow: 6 }), strings)).toBe(1);
  });

  it('counts one inside an open shadow root that a closed one holds', () => {
    expect(unmaskableCount(documentWith({ name: 3, attributes: [4, 5], shadow: 6, nested: 7 }), strings)).toBe(1);
  });

  it('leaves out what a selector reaches, what is not rendered, and what holds no secret', () => {
    expect(unmaskableCount(documentWith({ name: 3, attributes: [4, 5], shadow: 7 }), strings)).toBe(0);
    expect(unmaskableCount(documentWith({ name: 3, attributes: [4, 5] }), strings)).toBe(0);
    expect(unmaskableCount(documentWith({ name: 3, attributes: [4, 5], shadow: 6, rendered: false }), strings)).toBe(0);
    expect(unmaskableCount(documentWith({ name: 3, attributes: [4, 9], shadow: 6 }), strings)).toBe(0);
  });
});
