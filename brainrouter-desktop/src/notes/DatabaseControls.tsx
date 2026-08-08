/**
 * ADR-029 E3 — the controls that drive a view: filter, sort, group, columns.
 *
 * **Every one of these writes a saved view and nothing else.** A filter is a
 * list of typed rules stored on the database block; core evaluates it and
 * answers with the rows. So there is no second filtering implementation to
 * disagree with, and the same saved view hides the same rows on every surface —
 * which is the whole of `databaseView.ts`'s opening argument, made reachable.
 *
 * The operators a rule may use come from `notes-database-read`, which got them
 * from core's `operatorsFor`. A picker that built its own list could offer a
 * combination the evaluator then reports as skipped, and the person would see a
 * filter that appears to be applied and silently is not.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../icons.js';
// F2 — core's parser, run in the renderer so the editor reports the same
// sentence the cell would. A second grammar here would accept a formula the
// evaluator then refuses, one column at a time.
import { parseFormula } from '@kinqs/brainrouter-core/notes/editing';
import { CellEditorFor, Popover, usePopoverAnchor } from './DatabaseCell.js';
import {
  filterSummary, filterValueEditor, flatFilter, groupSummary, groupableProperties,
  isCompleteFilterRule, nestedFilterNote, newFilterRule, operatorLabel, propertyTypeLabel, sortSummary,
  viewKindHint, viewKindLabel, VIEW_KINDS, writeFilter,
  type DatabasePropertyDto, type DatabaseReadDto, type NoteFilterOperator,
  type NoteFilterRule, type NotePropertyValue, type NoteRollupAggregate, type NoteRollupSpec,
  type NoteSortRule, type NoteViewKind, type PropertyCatalogDto,
} from '../lib/notes/database.js';
import type { DatabaseOps, PropertyConfig } from './databaseOps.js';

export interface ControlProps {
  dto: DatabaseReadDto;
  ops: DatabaseOps;
  refLabels: Record<string, string>;
}

/** A toolbar button that opens one popover. Shared so they cannot drift apart. */
function Tool({ label, active, children }: {
  label: string;
  active: boolean;
  children: (close: () => void) => React.ReactNode;
}): React.ReactElement {
  const popover = usePopoverAnchor();
  return (
    <>
      <button className={`db-tool${active ? ' is-on' : ''}`} onClick={popover.openFrom}>
        {label} <Icon name="chev-down" size={9} />
      </button>
      {popover.rect ? (
        <Popover anchor={popover.rect} onClose={popover.close}>{children(popover.close)}</Popover>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ filter */

export function FilterControl({ dto, ops, refLabels }: ControlProps): React.ReactElement {
  const flat = flatFilter(dto.view.filter);
  const byId = new Map(dto.properties.map((property) => [property.id, property] as const));
  const nested = nestedFilterNote(flat);
  /**
   * The condition being built, which is NOT in the saved view yet.
   *
   * Core reads `status is <nothing>` as matching nothing — correctly, an empty
   * cell must not satisfy a comparison — so saving on the click that picked the
   * property would empty the view before the person has said what they are
   * filtering for.
   */
  const [draft, setDraft] = useState<NoteFilterRule | null>(null);

  const save = (rules: NoteFilterRule[], combinator: 'and' | 'or' = flat.combinator): void => {
    void ops.saveView({ viewId: dto.view.id, filter: writeFilter({ ...flat, combinator, rules }) ?? null });
  };
  /** A draft becomes a condition the moment it can actually be evaluated. */
  const commit = (rule: NoteFilterRule): void => {
    if (!isCompleteFilterRule(rule)) { setDraft(rule); return; }
    setDraft(null);
    save([...flat.rules, rule]);
  };

  const ruleRow = (
    rule: NoteFilterRule,
    key: string,
    lead: React.ReactNode,
    onRule: (next: NoteFilterRule) => void,
    onRemove: () => void,
  ): React.ReactElement => {
    const property = byId.get(rule.property);
    return (
      <div className="db-rule" key={key}>
        <div className="db-rule-head">
          <span className="db-rule-lead">{lead}</span>
          <span className="db-rule-name">{property?.name ?? rule.property}</span>
          <button className="db-icon-btn" aria-label="Remove this condition" onClick={onRemove}>
            <Icon name="close" size={10} />
          </button>
        </div>
        {property ? (
          <>
            <OperatorPicker
              property={property}
              operator={rule.operator}
              // The value is dropped with the operator: `is-any-of` takes a list
              // where `is` takes one option, and carrying the old shape across
              // would leave a rule core evaluates against the wrong kind of
              // value with no sign on screen that it happened.
              onPick={(operator) => onRule({ property: rule.property, operator })}
            />
            <RuleValue
              property={property}
              rule={rule}
              refLabels={refLabels}
              searchRefs={ops.searchRefs}
              onOpenRef={ops.openRef}
              onValue={(value) => onRule({ ...rule, value })}
            />
          </>
        ) : (
          // The rule survives a column being removed. Core reports it as skipped
          // rather than applying it, and deleting it here would throw away a
          // condition that comes back the moment the column is re-added with the
          // same id.
          <span className="db-popover-empty">This column is not in the database any more.</span>
        )}
      </div>
    );
  };

  return (
    <Tool label={filterSummary(dto)} active={flat.rules.length + flat.nested.length > 0}>
      {() => (
        <>
          {flat.rules.map((rule, index) => ruleRow(
            rule,
            `${rule.property}:${index}`,
            // Only the FIRST row names the combinator, and changing it changes
            // all of them: a per-row and/or would suggest a precedence this flat
            // editor does not have.
            index === 0 ? 'Where' : (
              <button
                className="db-rule-join"
                onClick={() => save(flat.rules, flat.combinator === 'and' ? 'or' : 'and')}
              >
                {flat.combinator}
              </button>
            ),
            (next) => save(flat.rules.map((current, at) => (at === index ? next : current))),
            () => save(flat.rules.filter((_, at) => at !== index)),
          ))}

          {draft ? ruleRow(
            draft,
            'draft',
            flat.rules.length === 0 ? 'Where' : flat.combinator,
            commit,
            () => setDraft(null),
          ) : null}

          {nested ? <p className="db-popover-note">{nested}</p> : null}

          <PropertyMenu
            label="Add a condition"
            properties={dto.properties.filter((property) => property.operators.length > 0)}
            onPick={(property) => {
              const rule = newFilterRule(property);
              if (rule) commit(rule);
            }}
          />
          {flat.rules.length > 0 ? (
            <button className="db-popover-clear" onClick={() => save([])}>Remove every condition</button>
          ) : null}
        </>
      )}
    </Tool>
  );
}

function OperatorPicker({ property, operator, onPick }: {
  property: DatabasePropertyDto;
  operator: NoteFilterOperator;
  onPick: (operator: NoteFilterOperator) => void;
}): React.ReactElement {
  return (
    <div className="db-op-row">
      {property.operators.map((candidate) => (
        <button
          key={candidate}
          className={`db-op${candidate === operator ? ' is-on' : ''}`}
          onClick={() => onPick(candidate)}
        >
          {operatorLabel(candidate)}
        </button>
      ))}
    </div>
  );
}

function RuleValue({ property, rule, refLabels, searchRefs, onOpenRef, onValue }: {
  property: DatabasePropertyDto;
  rule: NoteFilterRule;
  refLabels: Record<string, string>;
  searchRefs: (query: string) => Promise<Array<{ uri: string; label: string; mode: string }>>;
  onOpenRef: (uri: string) => void;
  onValue: (value: NotePropertyValue) => void;
}): React.ReactElement | null {
  const editor = filterValueEditor(property, rule.operator);
  if (editor === 'none') return null;
  return (
    <div className="db-field">
      <CellEditorFor
        property={property}
        editor={editor}
        value={rule.value ?? null}
        display={String(rule.value ?? '')}
        refLabels={refLabels}
        onWrite={onValue}
        // A filter must not edit the schema: adding an option from a condition
        // would put a word in the column because somebody searched for it.
        onAddOption={() => {}}
        searchRefs={searchRefs}
        onOpenRef={onOpenRef}
        variant="field"
      />
    </div>
  );
}

/* -------------------------------------------------------------------- sort */

export function SortControl({ dto, ops }: ControlProps): React.ReactElement {
  const rules = dto.view.sort ?? [];
  const byId = new Map(dto.properties.map((property) => [property.id, property] as const));
  const save = (next: NoteSortRule[]): void => void ops.saveView({ viewId: dto.view.id, sort: next });

  return (
    <Tool label={sortSummary(dto)} active={rules.length > 0}>
      {() => (
        <>
          {rules.map((rule, index) => (
            <div className="db-rule" key={`${rule.property}:${index}`}>
              <div className="db-rule-head">
                {/* The order of the rules IS the tie-break order, so it has to be
                    visible and movable — a list you cannot reorder makes the
                    second sort key an accident of when it was added. */}
                <span className="db-rule-lead">{index === 0 ? 'Sort by' : 'then by'}</span>
                <span className="db-rule-name">{byId.get(rule.property)?.name ?? rule.property}</span>
                <button
                  className="db-op is-on"
                  onClick={() => save(rules.map((current, at) => (
                    at === index ? { ...current, direction: current.direction === 'asc' ? 'desc' : 'asc' } : current
                  )))}
                >
                  {rule.direction === 'asc' ? 'ascending' : 'descending'}
                </button>
                {index > 0 ? (
                  <button
                    className="db-icon-btn" aria-label="Sort by this first"
                    onClick={() => {
                      const next = [...rules];
                      const [moved] = next.splice(index, 1);
                      next.splice(index - 1, 0, moved!);
                      save(next);
                    }}
                  >
                    <Icon name="chev-up" size={10} />
                  </button>
                ) : null}
                <button
                  className="db-icon-btn" aria-label="Remove this sort"
                  onClick={() => save(rules.filter((_, at) => at !== index))}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            </div>
          ))}
          <PropertyMenu
            label="Add a sort"
            properties={dto.properties.filter((property) => (
              !property.unsupported && !rules.some((rule) => rule.property === property.id)
            ))}
            onPick={(property) => save([...rules, { property: property.id, direction: 'asc' }])}
          />
          {rules.length > 0 ? (
            <button className="db-popover-clear" onClick={() => save([])}>
              Back to the order the rows were added in
            </button>
          ) : null}
        </>
      )}
    </Tool>
  );
}

/* ------------------------------------------------------------------- group */

export function GroupControl({ dto, ops }: ControlProps): React.ReactElement {
  const options = groupableProperties(dto);
  return (
    <Tool label={groupSummary(dto)} active={!!dto.view.groupBy}>
      {(close) => (
        <>
          <p className="db-popover-note">
            {/* Core's rule, said where the choice is made rather than only after
                it is missing: a board with nothing to group by still shows every
                row, in one column. */}
            A board and a calendar need this. Every other view can use it too.
          </p>
          <div className="db-option-list">
            {options.map((property) => (
              <button
                key={property.id}
                className={`db-option${dto.view.groupBy === property.id ? ' is-on' : ''}`}
                onClick={() => { void ops.saveView({ viewId: dto.view.id, groupBy: property.id }); close(); }}
              >
                <span className="db-option-check">{dto.view.groupBy === property.id ? '✓' : ''}</span>
                <span className="db-option-label">{property.name}</span>
                <span className="db-option-mode">{propertyTypeLabel(property.type)}</span>
              </button>
            ))}
            {options.length === 0 ? (
              <span className="db-popover-empty">Add a select, a date or a checkbox column to group by.</span>
            ) : null}
          </div>
          {dto.view.groupBy ? (
            <button
              className="db-popover-clear"
              onClick={() => { void ops.saveView({ viewId: dto.view.id, groupBy: null }); close(); }}
            >
              Stop grouping
            </button>
          ) : null}
        </>
      )}
    </Tool>
  );
}

/* -------------------------------------------------------------- properties */

/**
 * Which columns a view shows, in what order, and the schema behind them.
 *
 * Hiding a column and removing one are deliberately different actions in
 * different places: hiding writes `visible` on this view, removing edits the
 * schema for every view. Core keeps the VALUES either way — re-adding a property
 * with the same id brings its data straight back — and the copy says so, because
 * "Remove" beside a column of writing reads as "delete this".
 *
 * The type list is core's, through `propertyCatalog`. It used to be nine strings
 * in this file, which is the same defect one layer up from the operators: a
 * renderer that names the types itself offers whatever it was written with, and
 * a build that learns a tenth type would never show it.
 */
export function PropertiesControl({ dto, ops }: ControlProps): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('text');
  const [config, setConfig] = useState<PropertyConfig>({});
  /** Which existing column's expression is open for editing. */
  const [editing, setEditing] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PropertyCatalogDto | null>(null);
  const visible = new Set(dto.view.visible);

  // Once per mount. The dependency is the METHOD rather than `ops`, which is
  // rebound on every read of the database — depending on the object would put a
  // round trip behind every cell edit and every sync tick, for an answer that
  // cannot change while the process runs.
  const readCatalog = ops.propertyCatalog;
  useEffect(() => {
    let cancelled = false;
    void readCatalog().then((answer) => { if (!cancelled) setCatalog(answer); });
    return () => { cancelled = true; };
  }, [readCatalog]);

  /**
   * Move a column one place earlier, in the database AND in this view.
   *
   * Both, because they are two different orders and each alone is wrong: the
   * schema order is what every view starts from and what these pickers list,
   * and the view's `visible` is what the table on screen actually renders. Only
   * the schema and the arrow appears to do nothing; only the view and the
   * database's own order never learns where the person wanted the column.
   */
  const moveEarlier = (propertyId: string): void => {
    const order = dto.properties.map((property) => property.id);
    const at = order.indexOf(propertyId);
    if (at <= 0) return;
    const swapped = [...order];
    [swapped[at - 1], swapped[at]] = [swapped[at]!, swapped[at - 1]!];
    void (async () => {
      await ops.reorderProperties(swapped);
      // The same swap, applied to what this view shows. A column that is hidden
      // has no on-screen position, so it moves in the schema only.
      const shown = dto.view.visible;
      const here = shown.indexOf(propertyId);
      const before = shown.indexOf(order[at - 1]!);
      if (here <= 0 || before < 0) return;
      const nextVisible = [...shown];
      [nextVisible[before], nextVisible[here]] = [nextVisible[here]!, nextVisible[before]!];
      await ops.saveView({ viewId: dto.view.id, visible: nextVisible });
    })();
  };

  return (
    <Tool label="Columns" active={false}>
      {() => (
        <>
          <div className="db-option-list">
            {dto.properties.map((property, index) => (
              <div className="db-prop-row" key={property.id}>
                <button
                  className={`db-option${visible.has(property.id) ? ' is-on' : ''}`}
                  // The title column is what a row is called; a view with it
                  // hidden is a list of blank lines.
                  disabled={property.type === 'title'}
                  onClick={() => void ops.saveView({
                    viewId: dto.view.id,
                    visible: visible.has(property.id)
                      ? dto.view.visible.filter((id) => id !== property.id)
                      : [...dto.view.visible, property.id],
                  })}
                >
                  <span className="db-option-check">{visible.has(property.id) ? '✓' : ''}</span>
                  <span className="db-option-label">{property.name}</span>
                  <span className="db-option-mode">
                    {propertyTypeLabel(property.type)}{property.unsupported ? ' · not readable here' : ''}
                  </span>
                </button>
                {/* The first row keeps the button's WIDTH and loses its glyph,
                    so the names below it do not shift left by one control. */}
                {index === 0 ? <span className="db-icon-btn" /> : (
                  <button
                    className="db-icon-btn"
                    title="Move this column one place earlier"
                    aria-label={`Move ${property.name} earlier`}
                    onClick={() => moveEarlier(property.id)}
                  >
                    <Icon name="chev-up" size={10} />
                  </button>
                )}
                {needsConfig(property.type) ? (
                  <button
                    className="db-icon-btn"
                    title="Change what this column works out"
                    aria-label={`Change what ${property.name} works out`}
                    onClick={() => setEditing(editing === property.id ? null : property.id)}
                  >
                    <Icon name="edit" size={10} />
                  </button>
                ) : null}
                {property.type === 'title' ? null : (
                  <button
                    className="db-icon-btn"
                    title="Remove this column. The values stay on the rows."
                    aria-label={`Remove ${property.name}`}
                    onClick={() => void ops.removeProperty(property.id)}
                  >
                    <Icon name="trash" size={10} />
                  </button>
                )}
                {/* F2 — rewriting an expression is safe in a way changing a
                    TYPE is not: nothing is stored under a derived column, so a
                    rewrite recomputes from the same data and the worst outcome
                    is a cell that says why it cannot be worked out. */}
                {editing === property.id ? (
                  <div className="db-prop-config">
                    {property.type === 'formula' ? (
                      <FormulaField
                        value={property.formula ?? ''}
                        catalog={catalog}
                        onChange={(formula) => { void ops.configureProperty(property.id, { formula }); setEditing(null); }}
                      />
                    ) : (
                      <RollupField
                        dto={dto} ops={ops} catalog={catalog} value={property.rollup}
                        onChange={(rollup) => { void ops.configureProperty(property.id, { rollup }); setEditing(null); }}
                      />
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {adding ? (
            <div className="db-add-prop">
              <input
                className="filter db-popover-input" autoFocus placeholder="Column name" value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  // F2 — a formula or a rollup is NOT finished at Enter: it
                  // needs its expression or its configuration, and a column
                  // added without one renders "this has not been set up yet" in
                  // every row until somebody goes back for it.
                  if (event.key !== 'Enter' || !name.trim() || needsConfig(type)) return;
                  void ops.addProperty(name.trim(), type);
                  setName(''); setAdding(false);
                }}
              />
              <div className="db-op-row">
                {(catalog?.types ?? [])
                  // A row's title is the row page's own, and there is exactly
                  // one: core refuses a second, so offering it is a button that
                  // always fails.
                  .filter((candidate) => candidate.type !== 'title')
                  .map((candidate) => (
                    <button
                      key={candidate.type}
                      className={`db-op${candidate.type === type ? ' is-on' : ''}`}
                      onClick={() => setType(candidate.type)}
                    >
                      {propertyTypeLabel(candidate.type)}
                    </button>
                  ))}
                {catalog ? null : <span className="db-popover-empty">Reading the column types…</span>}
              </div>
              {/* F2 — the expression and the rollup configuration are part of
                  ADDING the column, for the reason E6 gives about a row created
                  without its cells: the window in between is a column that says
                  it does not work. */}
              {type === 'formula' ? (
                <FormulaField value={config.formula ?? ''} catalog={catalog} onChange={(formula) => setConfig({ formula })} />
              ) : null}
              {type === 'rollup' ? (
                <RollupField dto={dto} ops={ops} catalog={catalog} value={config.rollup} onChange={(rollup) => setConfig({ rollup })} />
              ) : null}
              <button
                className="db-popover-ok"
                disabled={!name.trim() || (needsConfig(type) && !isConfigured(type, config))}
                onClick={() => {
                  void ops.addProperty(name.trim(), type, needsConfig(type) ? config : undefined);
                  setName(''); setConfig({}); setAdding(false);
                }}
              >
                Add the column
              </button>
            </div>
          ) : (
            <button className="db-popover-clear" onClick={() => setAdding(true)}>
              <Icon name="plus" size={10} /> New column
            </button>
          )}
          <p className="db-popover-note">
            Removing a column keeps every value on the rows. Adding it back with the same name brings them
            straight back.
          </p>
        </>
      )}
    </Tool>
  );
}

/* ------------------------------------------------------------------- views */

/** The tabs: one per stored view, plus the way to make another. */
export function ViewTabs({ dto, ops }: ControlProps): React.ReactElement {
  const addMenu = usePopoverAnchor();
  const renameMenu = usePopoverAnchor();
  const [draft, setDraft] = useState('');

  return (
    <div className="db-view-tabs">
      {dto.views.map((view) => (
        <button
          key={view.id}
          className={`db-view-tab${view.id === dto.view.id ? ' is-on' : ''}`}
          onClick={(event) => {
            if (view.id === dto.view.id) { setDraft(view.name); renameMenu.openFrom(event); return; }
            ops.openView(view.id);
          }}
          title={view.id === dto.view.id ? 'Rename or remove this view' : viewKindLabel(view.kind)}
        >
          {view.name}
          {/* The kind only when the NAME does not already say it. A view core
              named after its kind would otherwise render as "Table TABLE". */}
          {view.name.trim().toLowerCase() === viewKindLabel(view.kind).toLowerCase()
            ? null
            : <span className="db-view-kind">{viewKindLabel(view.kind)}</span>}
        </button>
      ))}
      <button className="db-view-add" aria-label="Add a view" onClick={addMenu.openFrom}>
        <Icon name="plus" size={11} />
      </button>

      {addMenu.rect ? (
        <Popover anchor={addMenu.rect} onClose={addMenu.close}>
          <div className="db-option-list">
            {VIEW_KINDS.map((kind: NoteViewKind) => (
              <button
                key={kind}
                className="db-option"
                onClick={() => { void ops.saveView({ kind, name: viewKindLabel(kind) }); addMenu.close(); }}
              >
                <span className="db-option-label">{viewKindLabel(kind)}</span>
                <span className="db-option-mode">{viewKindHint(kind)}</span>
              </button>
            ))}
          </div>
        </Popover>
      ) : null}

      {renameMenu.rect ? (
        <Popover anchor={renameMenu.rect} onClose={renameMenu.close}>
          <input
            className="filter db-popover-input" autoFocus value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              void ops.saveView({ viewId: dto.view.id, name: draft.trim() || dto.view.name });
              renameMenu.close();
            }}
          />
          <div className="db-op-row">
            {VIEW_KINDS.map((kind: NoteViewKind) => (
              <button
                key={kind}
                className={`db-op${kind === dto.view.kind ? ' is-on' : ''}`}
                onClick={() => void ops.saveView({ viewId: dto.view.id, kind })}
              >
                {viewKindLabel(kind)}
              </button>
            ))}
          </div>
          {dto.views.length > 1 ? (
            <button
              className="db-popover-clear"
              onClick={() => { void ops.removeView(dto.view.id); renameMenu.close(); }}
            >
              Remove this view
            </button>
          ) : (
            // Core refuses to remove the last view. Said here rather than
            // discovered as a refusal, because a button that always fails reads
            // as the app being broken.
            <p className="db-popover-note">A database keeps at least one view.</p>
          )}
        </Popover>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

function PropertyMenu({ label, properties, onPick }: {
  label: string;
  properties: readonly DatabasePropertyDto[];
  onPick: (property: DatabasePropertyDto) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="db-popover-clear" onClick={() => setOpen(true)}>
        <Icon name="plus" size={10} /> {label}
      </button>
    );
  }
  return (
    <div className="db-option-list">
      {properties.map((property) => (
        <button key={property.id} className="db-option" onClick={() => { onPick(property); setOpen(false); }}>
          <span className="db-option-label">{property.name}</span>
          <span className="db-option-mode">{propertyTypeLabel(property.type)}</span>
        </button>
      ))}
      {properties.length === 0 ? <span className="db-popover-empty">Nothing left to add.</span> : null}
    </div>
  );
}

/* ------------------------------------------------- F2 — the derived columns */

/** Types that are not finished until they are configured. */
function needsConfig(type: string): boolean {
  return type === 'formula' || type === 'rollup';
}

function isConfigured(type: string, config: PropertyConfig): boolean {
  if (type === 'formula') return (config.formula ?? '').trim().length > 0;
  if (type === 'rollup') return !!config.rollup?.relation && !!config.rollup.aggregate;
  return true;
}

/**
 * The expression, checked AS IT IS TYPED.
 *
 * The parser is core's and it is pure, so the renderer runs the same one the
 * evaluator does — there is no second grammar to disagree with. That is what
 * lets the editor say "there is an opening bracket with no closing one" while
 * somebody is still typing, instead of saving a column that then reports the
 * same sentence in four hundred cells.
 *
 * It is checked and never EVALUATED here: a formula's value depends on a row,
 * and this editor does not have one.
 */
function FormulaField({ value, catalog, onChange }: {
  value: string;
  catalog: PropertyCatalogDto | null;
  onChange: (formula: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(value);
  const problem = useMemo(() => {
    if (draft.trim().length === 0) return null;
    const parsed = parseFormula(draft);
    return parsed.ok ? null : parsed.error.message;
  }, [draft]);

  return (
    <div className="db-formula">
      <textarea
        className="filter db-formula-input"
        rows={3}
        placeholder={'Cost * Quantity'}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {problem
        ? <span className="db-formula-problem">{problem}</span>
        : <span className="db-popover-note">Refer to a column by its name, or with prop(&quot;Name&quot;).</span>}
      <div className="db-op-row db-formula-fns">
        {(catalog?.functions ?? []).slice(0, 40).map((fn) => (
          <button
            key={fn.name}
            className="db-op"
            title={fn.summary}
            onClick={() => setDraft(`${draft}${fn.name}(`)}
          >
            {fn.name}
          </button>
        ))}
      </div>
      <button
        className="db-popover-ok"
        disabled={draft.trim().length === 0 || !!problem}
        onClick={() => onChange(draft.trim())}
      >
        Use this formula
      </button>
    </div>
  );
}

const AGGREGATE_LABELS: Record<string, string> = {
  count: 'How many',
  sum: 'Total',
  average: 'Average',
  min: 'Smallest',
  max: 'Largest',
  earliest: 'Earliest',
  latest: 'Latest',
  'show-original': 'Show them',
};

/**
 * What a rollup follows, and what it does with what it finds.
 *
 * The TARGET list comes from `notes-rollup-targets`, which walks where the
 * chosen relation actually points. A list of this database's own columns would
 * be the wrong database entirely, and a fixed list would offer a column the
 * other end does not have — an offer the product cannot honour, which is the
 * defect F1 is about.
 */
function RollupField({ dto, ops, catalog, value, onChange }: {
  dto: DatabaseReadDto;
  ops: DatabaseOps;
  catalog: PropertyCatalogDto | null;
  value: NoteRollupSpec | undefined;
  onChange: (rollup: NoteRollupSpec) => void;
}): React.ReactElement {
  const relations = dto.properties.filter((property) => property.type === 'relation');
  const [spec, setSpec] = useState<NoteRollupSpec>(value ?? {
    relation: relations[0]?.id ?? '',
    target: '',
    aggregate: 'count',
  });
  const [targets, setTargets] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [looked, setLooked] = useState(false);

  const lookUp = ops.rollupTargets;
  useEffect(() => {
    if (!spec.relation) { setTargets([]); setLooked(true); return; }
    let cancelled = false;
    setLooked(false);
    void lookUp(spec.relation)
      .then((answer) => {
        if (cancelled) return;
        setTargets(answer.properties ?? []);
        setLooked(true);
      })
      .catch(() => { if (!cancelled) setLooked(true); });
    return () => { cancelled = true; };
  }, [spec.relation, lookUp]);

  if (relations.length === 0) {
    return (
      <p className="db-popover-note">
        A rollup summarises rows a relation points at, and this database has no relation column yet.
      </p>
    );
  }

  return (
    <div className="db-rollup">
      <span className="db-popover-note">Follow</span>
      <div className="db-op-row">
        {relations.map((relation) => (
          <button
            key={relation.id}
            className={`db-op${relation.id === spec.relation ? ' is-on' : ''}`}
            onClick={() => setSpec({ ...spec, relation: relation.id, target: '' })}
          >
            {relation.name}
          </button>
        ))}
      </div>
      <span className="db-popover-note">and</span>
      <div className="db-op-row">
        {(catalog?.aggregates ?? []).map((aggregate) => (
          <button
            key={aggregate}
            className={`db-op${aggregate === spec.aggregate ? ' is-on' : ''}`}
            onClick={() => setSpec({ ...spec, aggregate: aggregate as NoteRollupAggregate })}
          >
            {AGGREGATE_LABELS[aggregate] ?? aggregate}
          </button>
        ))}
      </div>
      {spec.aggregate === 'count' ? null : (
        <>
          <span className="db-popover-note">of</span>
          <div className="db-op-row">
            {targets.map((target) => (
              <button
                key={target.id}
                className={`db-op${target.id === spec.target ? ' is-on' : ''}`}
                onClick={() => setSpec({ ...spec, target: target.id })}
              >
                {target.name}
              </button>
            ))}
            {/* Honest about WHY there is nothing to pick: a relation nobody has
                filled in yet has no other end to read columns from, which is a
                different situation from a lookup that failed. */}
            {looked && targets.length === 0 ? (
              <span className="db-popover-empty">
                Nothing is linked through this column yet, so there are no columns to summarise.
              </span>
            ) : null}
          </div>
        </>
      )}
      <button
        className="db-popover-ok"
        disabled={!spec.relation || (spec.aggregate !== 'count' && !spec.target)}
        onClick={() => onChange(spec)}
      >
        Use this rollup
      </button>
    </div>
  );
}
