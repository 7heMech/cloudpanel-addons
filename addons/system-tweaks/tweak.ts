// What one System Tweaks tweak declares. Each tweak module exports one, and
// registry.ts lists them and the order each phase runs them in; action.ts and
// the page do the rest. See docs/decisions/system-tweaks.md#how-the-code-is-laid-out.
import type { SYSTEM_TWEAKS_VERBS } from "./verbs";

export type SystemTweaksVerb = keyof typeof SYSTEM_TWEAKS_VERBS;

/** A tweak's settings, read under the settings lock, and its options. */
export interface TweakContext<S, O> {
  options: O;
  settings: S;
  /** Writes these settings into settings.json as it stands now. */
  save(patch: Partial<S>): void;
}

export interface VerbContext<S, O> {
  options: O;
  body(): Promise<Record<string, unknown>>;
  /**
   * Runs `body` under the settings lock, with the settings read when it was
   * taken. With `hold`, root's lock is asked first, under the settings lock,
   * and refuses any of `values` that is not `true` for a verb it covers.
   */
  locked<T>(body: (ctx: TweakContext<S, O>) => T | Promise<T>, hold?: { verb: SystemTweaksVerb; values: unknown[] }): Promise<T>;
  /** What the web is told while root has locked System Tweaks, or null when it has not. */
  lockRefusal(): string | null;
  /** Only holds the settings lock, for a change that does not read them. */
  exclusive<T>(body: () => Promise<T>): Promise<T>;
  /** The state, which most verbs answer with; `patch` replaces options for the read. */
  state(patch?: Partial<O>): Promise<unknown>;
}

/** One step of repair: the line it reports when it changed something, or nothing. */
export interface RepairStep<S, O> {
  /** What a failure is reported as, `<label>: <error>`; null reports the error alone. */
  label: string | null;
  /** Run under the settings lock; one that does not read the settings runs without. */
  locked: boolean;
  run(ctx: TweakContext<S, O>): string | null | false | Promise<string | null | false>;
}

/** Undoing a tweak when the addon is disabled. */
export interface WithdrawStep<S, O> {
  run(ctx: TweakContext<S, O>): void;
  /** Puts it back when a later step fails, since the addon then stays enabled. */
  putBack?(ctx: TweakContext<S, O>): void;
  /** Set when its failure does not keep the addon on: the warning logged instead. */
  warning?(error: string): string;
}

/** Putting a tweak back when the addon is enabled. */
export interface RestoreStep<S, O> {
  run(ctx: TweakContext<S, O>): void;
  /** Set when its failure does not stop the rest: the warning logged instead. */
  warning?(error: string): string;
}

export interface Tweak<S extends object, O extends object, St extends object> {
  /** Its settings and their defaults, in the order settings.json keeps them. */
  defaults?: S;
  /** Copies its valid stored settings over the defaults; without it, each boolean setting takes a stored boolean. */
  read?(stored: Record<string, unknown>, settings: S): void;
  /** Its part of what `state` answers, in the order `state` names it. */
  state?(ctx: { options: O; settings: S }): St | Promise<St>;
  /** Its on/off switch: the verb, how long the gateway may wait on it, and the change, made under the settings lock. */
  switch?: {
    verb: SystemTweaksVerb;
    /** The setting it saves, which root's lock holds on when `verbs.ts` says it covers the verb. */
    key: keyof S & string;
    timeout?: number;
    set(ctx: TweakContext<S, O>, on: boolean): void | Promise<void>;
  };
  /**
   * For a tweak root's lock covers without a switch: what Lock settings turns
   * on, the verb its failure is named by, and why it cannot be turned on now.
   */
  lockOn?: {
    verb: SystemTweaksVerb;
    blocked?(options: O): string | null;
    run(ctx: TweakContext<S, O>): void | Promise<void>;
  };
  /** Its settings as enabling the addon under root's lock starts them, beyond its switch: each at its default or on. */
  raise?(settings: S, defaults: S): Partial<S>;
  /** Verbs beyond the switch, such as a choice that is not on or off. */
  verbs?: { readonly [V in SystemTweaksVerb]?: (ctx: VerbContext<S, O>) => Promise<unknown> };
  repair?: { readonly [name: string]: RepairStep<S, O> };
  withdraw?: WithdrawStep<S, O>;
  restore?: RestoreStep<S, O>;
  /** Its row on the page; `locked` is root's lock on the addon. */
  row?(state: St, locked: boolean): string;
}

/** Keeps a tweak's settings, options and state types for registry.ts to combine. */
interface Typed<S, O, St> {
  readonly types?: { settings: S; options: O; state: St };
}

/**
 * Declares a tweak: `S` is its settings, `O` the options it reads (each
 * module's own, for tests), `St` its part of the state.
 */
export function tweak<S extends object = {}, O extends object = {}, St extends object = {}>() {
  return <T extends Tweak<S, O, St>>(definition: T): T & Typed<S, O, St> => definition;
}

/** A switch whose change is made before it is saved, so a failed change keeps the old setting. */
export function applyThenSave<K extends string, O>(key: K, apply: (on: boolean, options: O) => unknown) {
  return async (ctx: TweakContext<Record<K, boolean>, O>, on: boolean): Promise<void> => {
    await apply(on, ctx.options);
    ctx.save({ [key]: on } as Partial<Record<K, boolean>>);
  };
}

/** A switch saved before its change, so anything that runs meanwhile follows it; a failed change puts the old setting back. */
export function saveThenApply<K extends string, O>(key: K, apply: (on: boolean, options: O) => unknown) {
  return (ctx: TweakContext<Record<K, boolean>, O>, on: boolean): void => {
    const was = ctx.settings[key];
    ctx.save({ [key]: on } as Partial<Record<K, boolean>>);
    try {
      apply(on, ctx.options);
    } catch (error) {
      ctx.save({ [key]: was } as Partial<Record<K, boolean>>);
      throw error;
    }
  };
}
