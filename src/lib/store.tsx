"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { DEMO, initialParcels, randomCode, randomTicket, randomTracking, type Parcel } from "./demo";
import { openLockerDoorHardware, subscribeHardwareEvents } from "./hardwareBridge";
import { translate, type Lang, type TKey } from "./i18n";
import { DOOR_BY_ID, DOORS, SIZES, type Size } from "./locker";

export type Screen =
  | "attract"
  | "home"
  | "code"
  | "opened"
  | "done"
  | "expired"
  | "doorHelp"
  | "staffLogin"
  | "staffScan"
  | "staffPlace";

export type ToastTone = "ok" | "info" | "error";

export interface Toast {
  id: number;
  key: TKey;
  vars?: Record<string, string | number>;
  tone: ToastTone;
}

export interface PickupSession {
  code: string;
  doorIds: string[];
  closed: string[];
}

export interface StaffSession {
  placed: { tracking: string; doorId: string }[];
  current: { tracking: string; doorId: string } | null;
}

export interface State {
  screen: Screen;
  lang: Lang;
  parcels: Parcel[];
  openDoors: string[];
  codeValue: string;
  codeError: "wrong" | "locked" | null;
  attemptsLeft: number;
  lockedUntil: number | null;
  pickup: PickupSession | null;
  expiredReason: "expired" | "used";
  help: { selected: string | null; retried: boolean; ticket: string | null };
  staff: StaffSession | null;
  pinValue: string;
  pinError: boolean;
  toast: Toast | null;
  timeoutOpen: boolean;
  demoOpen: boolean;
  idleEnabled: boolean;
  hideCursor: boolean;
}

function initialState(): State {
  return {
    screen: "attract",
    lang: "mn",
    parcels: initialParcels(),
    openDoors: [],
    codeValue: "",
    codeError: null,
    attemptsLeft: DEMO.maxAttempts,
    lockedUntil: null,
    pickup: null,
    expiredReason: "expired",
    help: { selected: null, retried: false, ticket: null },
    staff: null,
    pinValue: "",
    pinError: false,
    toast: null,
    timeoutOpen: false,
    demoOpen: false,
    idleEnabled: true,
    hideCursor: false,
  };
}

type Action =
  | { type: "go"; screen: Screen }
  | { type: "lang"; lang: Lang }
  | { type: "codeDigit"; digit: string }
  | { type: "codeBack" }
  | { type: "codeClear" }
  | { type: "submitCode"; code: string; now: number }
  | { type: "unlock" }
  | { type: "closeDoor"; doorId: string; newCode: string }
  | { type: "pickupAllTaken" }
  | { type: "helpSelect"; doorId: string }
  | { type: "helpRetry" }
  | { type: "helpReport"; ticket: string }
  | { type: "reset" }
  | { type: "resetDemo"; keep: Pick<State, "idleEnabled" | "hideCursor"> }
  | { type: "pinDigit"; digit: string }
  | { type: "pinBack" }
  | { type: "pinClear" }
  | { type: "staffLogin"; ok: boolean }
  | { type: "staffScan"; tracking: string }
  | { type: "staffBigger" }
  | { type: "staffReopen" }
  | { type: "staffLogout" }
  | { type: "toast"; key: TKey; vars?: Record<string, string | number>; tone: ToastTone }
  | { type: "toastClear"; id: number }
  | { type: "timeout"; open: boolean }
  | { type: "demo"; open: boolean }
  | { type: "setting"; idleEnabled?: boolean; hideCursor?: boolean };

let toastSeq = 1;
const withToast = (s: State, key: TKey, tone: ToastTone, vars?: Record<string, string | number>): State => ({
  ...s,
  toast: { id: toastSeq++, key, tone, vars },
});

function busyDoors(s: State): Set<string> {
  const busy = new Set<string>(s.openDoors);
  for (const p of s.parcels) if (p.status === "stored" && p.doorId) busy.add(p.doorId);
  if (s.staff?.current) busy.add(s.staff.current.doorId);
  return busy;
}

function findFreeDoor(s: State, minSize: Size, exclude?: string): string | null {
  const busy = busyDoors(s);
  const start = SIZES.indexOf(minSize);
  for (const size of SIZES.slice(start)) {
    const door = DOORS.find((d) => d.size === size && !busy.has(d.id) && d.id !== exclude);
    if (door) return door.id;
  }
  return null;
}

function sizeForTracking(tracking: string): Size {
  const sum = [...tracking].reduce((a, c) => a + c.charCodeAt(0), 0) % 10;
  return sum < 5 ? "S" : sum < 8 ? "M" : "L";
}

function finishPickup(s: State): State {
  if (!s.pickup) return s;
  const ids = new Set(s.pickup.doorIds);
  return {
    ...s,
    screen: "done",
    parcels: s.parcels.map((p) =>
      p.status === "stored" && p.doorId && ids.has(p.doorId) && p.code === s.pickup!.code
        ? { ...p, status: "collected", doorId: null }
        : p,
    ),
    openDoors: s.openDoors.filter((d) => !ids.has(d)),
    pickup: { ...s.pickup, closed: [...s.pickup.doorIds] },
    timeoutOpen: false,
  };
}

function resetSession(s: State): State {
  return {
    ...s,
    screen: "attract",
    lang: "mn",
    openDoors: [],
    codeValue: "",
    codeError: null,
    pickup: null,
    help: { selected: null, retried: false, ticket: null },
    staff: null,
    pinValue: "",
    pinError: false,
    timeoutOpen: false,
  };
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "go":
      return { ...s, screen: a.screen, timeoutOpen: false };
    case "lang":
      return { ...s, lang: a.lang };

    case "codeDigit": {
      if (s.codeError === "locked") return s;
      if (s.codeError === "wrong") return { ...s, codeValue: a.digit, codeError: null };
      if (s.codeValue.length >= 6) return s;
      return { ...s, codeValue: s.codeValue + a.digit };
    }
    case "codeBack":
      if (s.codeError === "locked") return s;
      if (s.codeError === "wrong") return { ...s, codeValue: "", codeError: null };
      return { ...s, codeValue: s.codeValue.slice(0, -1) };
    case "codeClear":
      if (s.codeError === "locked") return s;
      return { ...s, codeValue: "", codeError: null };

    case "submitCode": {
      if (s.lockedUntil && a.now < s.lockedUntil) return { ...s, screen: "code", codeError: "locked" };
      const matches = s.parcels.filter((p) => p.code === a.code);
      const stored = matches.filter((p) => p.status === "stored" && p.doorId);
      if (stored.length > 0) {
        const doorIds = stored.map((p) => p.doorId!).sort();
        return {
          ...s,
          screen: "opened",
          openDoors: [...new Set([...s.openDoors, ...doorIds])],
          pickup: { code: a.code, doorIds, closed: [] },
          codeValue: "",
          codeError: null,
          attemptsLeft: DEMO.maxAttempts,
          lockedUntil: null,
          help: { selected: doorIds[0], retried: false, ticket: null },
          timeoutOpen: false,
        };
      }
      if (matches.some((p) => p.status === "expired")) {
        return { ...s, screen: "expired", expiredReason: "expired", codeValue: "", codeError: null };
      }
      if (matches.some((p) => p.status === "collected")) {
        return { ...s, screen: "expired", expiredReason: "used", codeValue: "", codeError: null };
      }
      const left = s.attemptsLeft - 1;
      if (left <= 0) {
        return {
          ...s,
          screen: "code",
          codeValue: a.code,
          codeError: "locked",
          attemptsLeft: 0,
          lockedUntil: a.now + DEMO.lockSeconds * 1000,
        };
      }
      return { ...s, screen: "code", codeValue: a.code, codeError: "wrong", attemptsLeft: left };
    }
    case "unlock":
      return { ...s, codeError: null, codeValue: "", attemptsLeft: DEMO.maxAttempts, lockedUntil: null };

    case "closeDoor": {
      if (s.pickup && s.pickup.doorIds.includes(a.doorId)) {
        const closed = [...new Set([...s.pickup.closed, a.doorId])];
        const next: State = {
          ...s,
          openDoors: s.openDoors.filter((d) => d !== a.doorId),
          pickup: { ...s.pickup, closed },
        };
        if (closed.length === s.pickup.doorIds.length) return finishPickup(next);
        return next;
      }
      if (s.staff?.current && s.staff.current.doorId === a.doorId) {
        const cur = s.staff.current;
        const parcel: Parcel = {
          id: `d${Date.now()}`,
          code: a.newCode,
          doorId: cur.doorId,
          tracking: cur.tracking,
          status: "stored",
          placedInDemo: true,
        };
        return withToast(
          {
            ...s,
            screen: "staffScan",
            parcels: [...s.parcels, parcel],
            openDoors: s.openDoors.filter((d) => d !== cur.doorId),
            staff: { placed: [{ tracking: cur.tracking, doorId: cur.doorId }, ...s.staff.placed], current: null },
          },
          "staff.place.codeSent",
          "ok",
          { d: cur.doorId },
        );
      }
      return { ...s, openDoors: s.openDoors.filter((d) => d !== a.doorId) };
    }
    case "pickupAllTaken":
      return finishPickup(s);

    case "helpSelect":
      return { ...s, help: { ...s.help, selected: a.doorId, retried: false } };
    case "helpRetry": {
      const id = s.help.selected;
      if (!id) return s;
      return { ...s, openDoors: [...new Set([...s.openDoors, id])], help: { ...s.help, retried: true } };
    }
    case "helpReport":
      return { ...s, help: { ...s.help, ticket: a.ticket } };

    case "reset":
      return resetSession(s);
    case "resetDemo":
      return { ...initialState(), ...a.keep };

    case "pinDigit":
      if (s.pinValue.length >= 6) return s;
      return { ...s, pinValue: s.pinValue + a.digit, pinError: false };
    case "pinBack":
      return { ...s, pinValue: s.pinValue.slice(0, -1), pinError: false };
    case "pinClear":
      return { ...s, pinValue: "", pinError: false };
    case "staffLogin":
      if (!a.ok) return { ...s, pinError: true, pinValue: "" };
      return { ...s, screen: "staffScan", staff: { placed: [], current: null }, pinValue: "", pinError: false };

    case "staffScan": {
      if (!s.staff) return s;
      const doorId = findFreeDoor(s, sizeForTracking(a.tracking));
      if (!doorId) return withToast(s, "staff.scan.noDoor", "error");
      return {
        ...s,
        screen: "staffPlace",
        openDoors: [...s.openDoors, doorId],
        staff: { ...s.staff, current: { tracking: a.tracking, doorId } },
      };
    }
    case "staffBigger": {
      const cur = s.staff?.current;
      if (!s.staff || !cur) return s;
      const size = DOOR_BY_ID[cur.doorId].size;
      const nextSize = SIZES[SIZES.indexOf(size) + 1];
      if (!nextSize) return withToast(s, "staff.place.noBigger", "error");
      const doorId = findFreeDoor(s, nextSize, cur.doorId);
      if (!doorId) return withToast(s, "staff.place.noBigger", "error");
      return {
        ...s,
        openDoors: [...s.openDoors.filter((d) => d !== cur.doorId), doorId],
        staff: { ...s.staff, current: { ...cur, doorId } },
      };
    }
    case "staffReopen": {
      const cur = s.staff?.current;
      if (!cur) return s;
      return withToast(s, "staff.place.reopened", "info", { d: cur.doorId });
    }
    case "staffLogout":
      return resetSession(s);

    case "toast":
      return withToast(s, a.key, a.tone, a.vars);
    case "toastClear":
      return s.toast && s.toast.id === a.id ? { ...s, toast: null } : s;
    case "timeout":
      return { ...s, timeoutOpen: a.open };
    case "demo":
      return { ...s, demoOpen: a.open };
    case "setting":
      return {
        ...s,
        idleEnabled: a.idleEnabled ?? s.idleEnabled,
        hideCursor: a.hideCursor ?? s.hideCursor,
      };
  }
}

function useKioskStore() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const ref = useRef(state);
  useEffect(() => {
    ref.current = state;
  }, [state]);

  const lastScanRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });

  const t = useCallback(
    (key: TKey, vars?: Record<string, string | number>) => translate(state.lang, key, vars),
    [state.lang],
  );

  const openDoor = useCallback((doorId: string) => {
    void openLockerDoorHardware(doorId);
  }, []);

  const actions = useMemo(() => {
    const takenCodes = () => new Set(ref.current.parcels.map((p) => p.code));

    const submitCode = (code: string) => {
      const matches = ref.current.parcels.filter((p) => p.code === code);
      const stored = matches.filter((p) => p.status === "stored" && p.doorId);
      const canOpen = !(ref.current.lockedUntil && Date.now() < ref.current.lockedUntil);

      dispatch({ type: "submitCode", code, now: Date.now() });

      if (canOpen && stored.length > 0) {
        const doorIds = stored.map((p) => p.doorId!).sort();
        for (const id of doorIds) openDoor(id);
      }
    };

    const staffScan = (tracking?: string) => {
      const track = tracking ?? randomTracking();
      const s = ref.current;
      if (!s.staff) return;

      const nextDoor = findFreeDoor(s, sizeForTracking(track));
      dispatch({ type: "staffScan", tracking: track });
      if (nextDoor) openDoor(nextDoor);
    };

    const staffBigger = () => {
      const cur = ref.current.staff?.current;
      if (!ref.current.staff || !cur) return;

      const size = DOOR_BY_ID[cur.doorId].size;
      const nextSize = SIZES[SIZES.indexOf(size) + 1];
      if (!nextSize) {
        dispatch({ type: "staffBigger" });
        return;
      }

      const nextDoor = findFreeDoor(ref.current, nextSize, cur.doorId);
      dispatch({ type: "staffBigger" });
      if (nextDoor) openDoor(nextDoor);
    };

    const staffReopen = () => {
      const curDoor = ref.current.staff?.current?.doorId;
      dispatch({ type: "staffReopen" });
      if (curDoor) openDoor(curDoor);
    };

    const helpRetry = () => {
      const selectedDoor = ref.current.help.selected;
      dispatch({ type: "helpRetry" });
      if (selectedDoor) openDoor(selectedDoor);
    };

    return {
      go: (screen: Screen) => dispatch({ type: "go", screen }),
      setLang: (lang: Lang) => dispatch({ type: "lang", lang }),
      codeDigit: (digit: string) => dispatch({ type: "codeDigit", digit }),
      codeBack: () => dispatch({ type: "codeBack" }),
      codeClear: () => dispatch({ type: "codeClear" }),
      submitCode,
      unlock: () => dispatch({ type: "unlock" }),
      closeDoor: (doorId: string) => dispatch({ type: "closeDoor", doorId, newCode: randomCode(takenCodes()) }),
      closeAllOpenDoors: () => {
        for (const id of [...ref.current.openDoors]) {
          dispatch({ type: "closeDoor", doorId: id, newCode: randomCode(takenCodes()) });
        }
      },
      pickupAllTaken: () => dispatch({ type: "pickupAllTaken" }),
      helpSelect: (doorId: string) => dispatch({ type: "helpSelect", doorId }),
      helpRetry,
      helpReport: () => dispatch({ type: "helpReport", ticket: randomTicket() }),
      reset: () => dispatch({ type: "reset" }),
      resetDemo: () =>
        dispatch({
          type: "resetDemo",
          keep: { idleEnabled: ref.current.idleEnabled, hideCursor: ref.current.hideCursor },
        }),
      pinDigit: (digit: string) => dispatch({ type: "pinDigit", digit }),
      pinBack: () => dispatch({ type: "pinBack" }),
      pinClear: () => dispatch({ type: "pinClear" }),
      submitPin: () => dispatch({ type: "staffLogin", ok: ref.current.pinValue === DEMO.staffPin }),
      staffQrLogin: () => dispatch({ type: "staffLogin", ok: true }),
      staffScan,
      staffBigger,
      staffReopen,
      staffConfirmClosed: () => {
        const cur = ref.current.staff?.current;
        if (cur) dispatch({ type: "closeDoor", doorId: cur.doorId, newCode: randomCode(takenCodes()) });
      },
      staffLogout: () => dispatch({ type: "staffLogout" }),
      toast: (key: TKey, tone: ToastTone = "info", vars?: Record<string, string | number>) =>
        dispatch({ type: "toast", key, tone, vars }),
      toastClear: (id: number) => dispatch({ type: "toastClear", id }),
      setTimeoutOpen: (open: boolean) => dispatch({ type: "timeout", open }),
      setDemoOpen: (open: boolean) => dispatch({ type: "demo", open }),
      setSetting: (v: { idleEnabled?: boolean; hideCursor?: boolean }) => dispatch({ type: "setting", ...v }),
    };
  }, [openDoor]);

  useEffect(() => {
    return subscribeHardwareEvents({
      onScan: (rawCode) => {
        const clean = rawCode.trim();
        if (!clean) return;

        const now = Date.now();
        if (lastScanRef.current.code === clean && now - lastScanRef.current.at < 800) {
          return;
        }
        lastScanRef.current = { code: clean, at: now };

        const cur = ref.current;
        if (cur.screen === "staffScan") {
          actions.staffScan(clean);
        } else if (cur.screen === "code" || cur.screen === "home" || cur.screen === "attract") {
          const code6 = clean.slice(0, 6);
          if (cur.screen !== "code") actions.go("code");
          actions.codeClear();
          for (const ch of code6) actions.codeDigit(ch);
          actions.submitCode(code6);
        }
      },
      onDoorClosed: (doorId) => {
        actions.closeDoor(doorId);
      },
    });
  }, [actions]);

  return { state, actions, t, stateRef: ref };
}

type KioskContextValue = ReturnType<typeof useKioskStore>;

const KioskContext = createContext<KioskContextValue | null>(null);

export function KioskProvider({ children }: { children: React.ReactNode }) {
  const value = useKioskStore();
  return <KioskContext.Provider value={value}>{children}</KioskContext.Provider>;
}

export function useKiosk(): KioskContextValue {
  const ctx = useContext(KioskContext);
  if (!ctx) throw new Error("useKiosk must be used inside <KioskProvider>");
  return ctx;
}