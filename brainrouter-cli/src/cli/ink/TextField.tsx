import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { Frame } from './Frame.js';

/**
 * Framed free-text input. Used by the wizard's API-key step, the
 * remote-URL prompt, and the /config / /login sub-prompts.
 *
 * The `validate` callback runs on submit. Return undefined to accept;
 * return a string to render it as an inline error and keep the field
 * open for the user to fix.
 */

export interface TextFieldProps {
  title: string;
  subtitle?: string;
  badge?: string;
  prefilled?: string;
  placeholder?: string;
  mask?: boolean;
  validate?: (value: string) => string | undefined;
  accentColor?: string;
  /** Back-compat: pulls accentColor from theme.mode if accentColor not set. */
  theme?: { mode: string };
  /** Ignored — kept for back-compat with old picker shape. */
  eraseOnClose?: boolean;
  /** Ignored — kept for back-compat. */
  footer?: string;
  onResolve: (result: TextFieldResult) => void;
}

export type TextFieldResult =
  | { kind: 'accept'; text: string }
  | { kind: 'cancelled' };

function themeToAccent(mode?: string): string | undefined {
  if (mode === 'light') return '#A24E1F';
  if (mode === 'mono') return 'white';
  if (mode === 'dark') return '#CC9166';
  return undefined;
}

export function TextField(props: TextFieldProps) {
  const [value, setValue] = useState(props.prefilled ?? '');
  const [error, setError] = useState<string | undefined>(undefined);

  // Exit-agnostic: just resolves. The caller (runTextField for the
  // standalone mount, or the chat overlay slot when invoked from inside
  // the Ink chat REPL) decides what to do. See Picker.tsx comment for
  // why a built-in `useApp().exit()` here would break the overlay path.
  const finish = (result: TextFieldResult) => {
    props.onResolve(result);
  };

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      finish({ kind: 'cancelled' });
    }
  });

  const onSubmit = (next: string) => {
    if (props.validate) {
      const verdict = props.validate(next);
      if (verdict !== undefined) {
        setError(verdict);
        return;
      }
    }
    finish({ kind: 'accept', text: next });
  };

  const onChange = (next: string) => {
    setValue(next);
    if (error) setError(undefined);
  };

  const accent = props.accentColor ?? themeToAccent(props.theme?.mode) ?? '#CC9166';
  return (
    <Frame
      title={props.title}
      subtitle={props.subtitle}
      badge={props.badge}
      footer={props.footer ?? '↵ accept  ·  esc cancel  ·  ⌫ erase'}
      accentColor={accent}
    >
      <Box>
        <Text color="cyan">› </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={props.placeholder}
          mask={props.mask ? '·' : undefined}
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      ) : null}
    </Frame>
  );
}
