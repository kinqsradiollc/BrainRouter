import React from 'react';
import type { ConfigSchemaDescriptor, ConfigSchemaField, ConfigSchemaSection } from '@kinqs/brainrouter-core/config';
import { Row, Toggle, KnobNumber, KnobText, Select } from '../shared/controls.js';

function valueAt(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function effectiveValue(field: ConfigSchemaField, raw: unknown): unknown {
  return raw === undefined ? field.defaultValue : raw;
}

function FieldControl({ field, raw, onChange }: {
  field: ConfigSchemaField;
  raw: unknown;
  onChange: (path: string, value: unknown) => void;
}): React.ReactElement {
  const current = effectiveValue(field, raw);
  if (field.type === 'boolean') {
    return <Toggle on={Boolean(current)} onChange={(v) => onChange(field.path, v)} />;
  }
  if (field.type === 'number') {
    return <KnobNumber value={raw} placeholder={String(field.defaultValue ?? 'default')} onSave={(v) => onChange(field.path, v)} />;
  }
  if (field.type === 'select') {
    return <Select value={String(current ?? '')} options={field.options ?? []} onChange={(v) => onChange(field.path, v)} />;
  }
  return <KnobText value={raw} placeholder={String(field.defaultValue ?? '')} onSave={(v) => onChange(field.path, v)} />;
}

export function SchemaCliFields({ schema, section, cli, onChange }: {
  schema: ConfigSchemaDescriptor | undefined;
  section: ConfigSchemaSection;
  cli: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
}): React.ReactElement | null {
  const fields = (schema?.fields ?? []).filter((field) => field.section === section);
  if (fields.length === 0) return null;
  return (
    <>
      {fields.map((field) => {
        const raw = valueAt(cli, field.path);
        return (
          <Row key={field.path} title={field.label} desc={field.description}>
            <FieldControl field={field} raw={raw} onChange={onChange} />
          </Row>
        );
      })}
    </>
  );
}
