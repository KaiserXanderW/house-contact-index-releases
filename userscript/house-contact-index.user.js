// ==UserScript==
// @name         novomind-house-contact-index
// @namespace    https://github.com/KaiserXanderW/house-contact-index-releases
// @version      0.1.8
// @description  Search the houses and put a house's Kurzwahl into the softphone dial field (Shift: the full number). Ships no data: import the contact list from the Violentmonkey menu.
// @include      /^[^:]*?://[^/]*?novomind[^/]*?/.*?$/
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @updateURL    https://raw.githubusercontent.com/KaiserXanderW/house-contact-index-releases/main/userscript/house-contact-index.user.js
// @downloadURL  https://raw.githubusercontent.com/KaiserXanderW/house-contact-index-releases/main/userscript/house-contact-index.user.js
// ==/UserScript==

"use strict";
(() => {
  // src/contacts.ts
  var CONTACTS_KIND = "house-contacts";
  var CONTACTS_SCHEMA_VERSION = 1;
  var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  var str = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
  var numText = (v) => typeof v === "number" && Number.isFinite(v) ? String(v) : str(v);
  var strList = (v) => {
    if (!Array.isArray(v)) return void 0;
    const out = v.map(str).filter((s) => !!s);
    return out.length ? out : void 0;
  };
  var SYNONYMS = {
    code: ["code", "houseId", "house_id", "houseCode", "house_code", "id"],
    houseNumber: ["houseNumber", "house_number", "number", "nr"],
    kurzwahl: ["kurzwahl", "shortDial", "short_dial"],
    phone: ["phone", "phoneNumber", "phone_number", "telephone", "tel"],
    email: ["email", "mail", "e-mail"],
    name: ["name", "houseName", "house_name"]
  };
  var KNOWN_KEYS = /* @__PURE__ */ new Set([
    ...Object.values(SYNONYMS).flat(),
    "address",
    "city",
    "country",
    "aliases",
    "notes",
    // Further numbers of a house (0.1.0–0.1.2 showed each as its own row).
    // Owner, 0.1.3: one number per house, so files that still carry them
    // import without a warning and the list is ignored.
    "numbers"
  ]);
  function cleanKurzwahl(k) {
    if (k === void 0) return void 0;
    const c = k.replace(/[\s()\-\u2010-\u2015\u2212]/g, "");
    return c || void 0;
  }
  function unwrap(text) {
    const t = text.replace(/^\ufeff/, "").trim();
    const fence = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i.exec(t);
    return fence ? fence[1] : t;
  }
  function parseContacts(raw) {
    let v = raw;
    if (typeof raw === "string") {
      try {
        v = JSON.parse(unwrap(raw));
      } catch (e) {
        return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    if (!isObj(v)) return { ok: false, error: "expected a JSON object" };
    if (v.kind !== CONTACTS_KIND) {
      return { ok: false, error: `"kind" must be "${CONTACTS_KIND}" \u2014 is this the right file? (it says ${JSON.stringify(v.kind ?? null)})` };
    }
    if (v.schemaVersion !== CONTACTS_SCHEMA_VERSION) {
      return { ok: false, error: `"schemaVersion" must be ${CONTACTS_SCHEMA_VERSION}` };
    }
    if (!Array.isArray(v.houses)) return { ok: false, error: `"houses" must be an array` };
    const warnings = [];
    const renamed = /* @__PURE__ */ new Map();
    const unknownKeys = /* @__PURE__ */ new Set();
    const badNumbers = [];
    const noDial = [];
    const houses = [];
    const pick = (h, key, as) => {
      for (const k of SYNONYMS[key]) {
        const val = as(h[k]);
        if (val === void 0) continue;
        if (k !== key) renamed.set(k, key);
        return val;
      }
      return void 0;
    };
    v.houses.forEach((h, i) => {
      if (!isObj(h)) {
        warnings.push(`house #${i + 1} skipped: not an object`);
        return;
      }
      const code = pick(h, "code", numText);
      const name = pick(h, "name", str);
      if (!code && !name) {
        warnings.push(`house #${i + 1} skipped: needs "code" or "name"`);
        return;
      }
      const label = code ?? name ?? "";
      let houseNumber = null;
      const rawNo = pick(h, "houseNumber", numText);
      if (rawNo !== void 0) {
        const m = /^#?\s*(\d+)$/.exec(rawNo);
        if (m) houseNumber = Number(m[1]);
        else badNumbers.push(label);
      }
      for (const k of Object.keys(h)) if (!KNOWN_KEYS.has(k)) unknownKeys.add(k);
      const house = {
        code: code ?? "",
        houseNumber,
        name: name ?? code ?? "",
        kurzwahl: cleanKurzwahl(pick(h, "kurzwahl", numText)),
        phone: pick(h, "phone", numText),
        email: pick(h, "email", str),
        address: str(h.address),
        city: str(h.city),
        country: str(h.country),
        aliases: strList(h.aliases),
        notes: str(h.notes)
      };
      for (const k of Object.keys(house)) if (house[k] === void 0) delete house[k];
      if (!house.kurzwahl && !house.phone) noDial.push(label);
      houses.push(house);
    });
    if (!houses.length) return { ok: false, error: "no usable houses" };
    for (const [from, to] of renamed) warnings.push(`read "${from}" as "${to}"`);
    if (unknownKeys.size) warnings.push(`ignored unknown keys: ${[...unknownKeys].join(", ")}`);
    if (badNumbers.length) warnings.push(`house number isn't a whole number, left empty: ${listSome(badNumbers)}`);
    if (noDial.length) warnings.push(`no Kurzwahl or phone number: ${listSome(noDial)}`);
    const codes = houses.map((h) => normalize(h.code)).filter(Boolean);
    const dupes = [...new Set(codes.filter((c, i) => codes.indexOf(c) !== i))];
    if (dupes.length) warnings.push(`house code listed more than once (all kept): ${listSome(dupes)}`);
    return {
      ok: true,
      warnings,
      data: {
        kind: CONTACTS_KIND,
        schemaVersion: CONTACTS_SCHEMA_VERSION,
        ...str(v.generatedAt) ? { generatedAt: str(v.generatedAt) } : {},
        ...str(v.source) ? { source: str(v.source) } : {},
        houses
      }
    };
  }
  function listSome(items) {
    return items.slice(0, 5).join(", ") + (items.length > 5 ? `, \u2026 (${items.length} in all)` : "");
  }
  var DASHES = /[-\u2010-\u2015\u2212]/g;
  function normalize(s) {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss").toLowerCase().replace(DASHES, "");
  }
  function fullNumber(phone) {
    return phone ? phone.replace(/[\s()/.\-\u2010-\u2015\u2212]/g, "") : "";
  }
  function dialString(n) {
    return n.kurzwahl || fullNumber(n.phone);
  }
  function rowOf(h) {
    return { house: h, dial: dialString(h), full: fullNumber(h.phone) };
  }
  function sortedHouses(data, by) {
    const rows = data.houses.map(rowOf);
    const text = (r) => by === "name" ? r.house.name : by === "id" ? r.house.code : r.house.kurzwahl ?? "";
    if (by === "number") {
      return rows.sort((a, b) => (a.house.houseNumber ?? Infinity) - (b.house.houseNumber ?? Infinity) || a.house.name.localeCompare(b.house.name));
    }
    return rows.sort((a, b) => {
      const ta = text(a), tb = text(b);
      if (!ta !== !tb) return ta ? -1 : 1;
      return ta.localeCompare(tb, void 0, { numeric: true }) || a.house.name.localeCompare(b.house.name);
    });
  }
  function houseHaystack(h) {
    return normalize([h.code, h.name, h.address, h.city, h.country, h.email, ...h.aliases ?? []].filter(Boolean).join(" | "));
  }
  function numberHaystack(h) {
    const phone = h.phone ? `${h.phone} | ${h.phone.replace(/\D/g, "")}` : "";
    return normalize([h.kurzwahl, phone].filter(Boolean).join(" | "));
  }
  function searchRows(data, query) {
    const terms = query.split(/\s+/).map(normalize).filter(Boolean);
    if (!terms.length) return [];
    const scored = [];
    data.houses.forEach((h, i) => {
      const hay = houseHaystack(h) + " | " + numberHaystack(h);
      const code = normalize(h.code);
      const num = h.houseNumber === null ? "" : String(h.houseNumber);
      const kw = normalize(h.kurzwahl ?? "");
      const nameWords = normalize(h.name).split(/[\s,/()·.:;]+/);
      let score = 0;
      const all = terms.every((t) => {
        const hit = hay.includes(t) || !!num && num.startsWith(t);
        if (!hit) return false;
        if (t === code) score += 100;
        else if (t === num) score += 90;
        else if (t === kw) score += 80;
        else if (code.startsWith(t)) score += 30;
        else if (nameWords.some((w) => w.startsWith(t))) score += 10;
        return true;
      });
      if (all) scored.push({ row: rowOf(h), score, i });
    });
    return scored.sort((a, b) => b.score - a.score || a.row.house.name.localeCompare(b.row.house.name) || a.i - b.i).map((s) => s.row);
  }

  // src/sites.ts
  var LAUNCHER_POS_KEY = "hci.launcherPos";
  var LAUNCHER_SIZE = 70;
  var DEFAULT_POS = { right: 20, bottom: 20 };
  function siteKeyForUrl(href) {
    try {
      const u = new URL(href);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      return `${u.protocol}//${u.hostname}`;
    } catch {
      return null;
    }
  }
  async function loadPositions(storage) {
    const raw = (await storage.get(LAUNCHER_POS_KEY))[LAUNCHER_POS_KEY];
    return raw && typeof raw === "object" ? { ...raw } : {};
  }
  async function savePosition(storage, key, pos) {
    const all = await loadPositions(storage);
    all[key] = { right: Math.round(pos.right), bottom: Math.round(pos.bottom) };
    await storage.set({ [LAUNCHER_POS_KEY]: all });
  }
  async function resetPosition(storage, key) {
    const all = await loadPositions(storage);
    if (!(key in all)) return;
    delete all[key];
    await storage.set({ [LAUNCHER_POS_KEY]: all });
  }
  function isValidPos(p) {
    const v = p;
    return !!v && Number.isFinite(v.right) && Number.isFinite(v.bottom);
  }
  function clampPos(pos, vw, vh) {
    const maxR = Math.max(0, vw - LAUNCHER_SIZE);
    const maxB = Math.max(0, vh - LAUNCHER_SIZE);
    return {
      right: Math.min(Math.max(0, pos.right), maxR),
      bottom: Math.min(Math.max(0, pos.bottom), maxB)
    };
  }

  // src/launcher.ts
  var DRAG_THRESHOLD = 4;
  var MAX_RESULTS = 5;
  var PANEL_MAX_WIDTH = 600;
  var GAP = 10;
  var MARGIN = 8;
  var TOAST_MS = 2e3;
  var SORT_BUTTONS = [
    { key: "name", label: ["Sort by", "Name"] },
    { key: "number", label: ["Sort by", "#"] },
    { key: "id", label: ["Sort by", "ID"] },
    { key: "kurzwahl", label: ["Sort by", "Kurzwahl"] }
  ];
  function panelPlacement(pos, vw, vh) {
    const maxWidth = Math.max(0, Math.min(PANEL_MAX_WIDTH, vw - 2 * MARGIN));
    const right = Math.min(Math.max(MARGIN, pos.right), Math.max(MARGIN, vw - MARGIN - maxWidth));
    const above = vh - pos.bottom - LAUNCHER_SIZE - MARGIN;
    const below = pos.bottom - MARGIN;
    const cap = Math.floor(vh * 0.8);
    const box = { right: `${right}px`, width: "auto", "max-width": `${maxWidth}px` };
    if (above >= Math.min(320, cap) || above >= below) {
      return { ...box, top: "auto", bottom: `${pos.bottom + LAUNCHER_SIZE}px`, "max-height": `${Math.max(0, Math.min(cap, above))}px` };
    }
    return { ...box, bottom: "auto", top: `${vh - pos.bottom}px`, "max-height": `${Math.max(0, Math.min(cap, below))}px` };
  }
  var mainNumber = (r) => {
    const { kurzwahl, phone } = r.house;
    if (kurzwahl && phone) return `Kurzwahl: ${kurzwahl} \xB7 ${phone}`;
    return kurzwahl ? `Kurzwahl: ${kurzwahl}` : phone ? `Phone: ${phone}` : "no number";
  };
  function rowText(r, by) {
    const h = r.house;
    const id = h.code || "\u2014";
    const num = h.houseNumber ?? "\u2014";
    switch (by) {
      case "name":
        return { strong: h.name, text: ` - ${id} - ${mainNumber(r)}` };
      case "number":
        return { strong: String(num), text: ` (#) - ${id} - ${h.name}` };
      case "id":
        return { strong: id, text: ` - House#: ${num} - ${h.name}` };
      case "kurzwahl":
        return { strong: h.kurzwahl ?? h.phone ?? "\u2014", text: ` - ${id} - ${h.name}` };
      default:
        return { text: `${h.name} - ${id} - ${mainNumber(r)}`, second: h.address || "No address available" };
    }
  }
  function setStyle(el, props) {
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, "important");
  }
  function mountLauncher(deps) {
    const doc = deps.doc ?? document;
    const win = doc.defaultView ?? window;
    let pos = isValidPos(deps.position) ? { ...deps.position } : { ...DEFAULT_POS };
    let open = false;
    let data = null;
    let loaded = false;
    let sortBy = "name";
    let rows = [];
    const el = (tag, cls) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      return e;
    };
    const launcher = el("hci-launcher");
    launcher.id = "hci-launcher";
    launcher.setAttribute("role", "button");
    launcher.setAttribute("aria-label", "House contact index");
    launcher.title = "House contact index \u2014 drag to move";
    launcher.tabIndex = 0;
    for (const t of ["House", "Contact", "Index"]) {
      const line = el("hci-line");
      line.textContent = t;
      launcher.appendChild(line);
    }
    const panel = el("hci-panel");
    panel.id = "hci-panel";
    panel.setAttribute("aria-label", "House contact index");
    const listBox = el("hci-list-box");
    const list = el("hci-list");
    list.setAttribute("role", "listbox");
    listBox.appendChild(list);
    const sortBar = el("hci-sort");
    const sortBtns = /* @__PURE__ */ new Map();
    for (const s of SORT_BUTTONS) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "hci-sort-btn";
      b.dataset.sort = s.key;
      const l1 = el("hci-line");
      l1.textContent = s.label[0];
      const l2 = el("hci-line");
      l2.textContent = s.label[1];
      b.append(l1, l2);
      sortBtns.set(s.key, b);
      sortBar.appendChild(b);
    }
    const search = doc.createElement("input");
    search.type = "text";
    search.id = "hci-search";
    search.placeholder = "Search (name, ID, #, Kurzwahl)...";
    search.setAttribute("aria-label", "Search houses");
    search.autocomplete = "off";
    search.spellcheck = false;
    panel.append(listBox, sortBar, search);
    const toastEl = el("hci-toast");
    toastEl.setAttribute("role", "status");
    let toastTimer = 0;
    const viewportEl = () => doc.compatMode === "BackCompat" && doc.body || doc.documentElement;
    const vw = () => viewportEl().clientWidth || win.innerWidth;
    const vh = () => viewportEl().clientHeight || win.innerHeight;
    const place = () => {
      const drawn = clampPos(pos, vw(), vh());
      setStyle(launcher, { right: `${drawn.right}px`, bottom: `${drawn.bottom}px` });
      setStyle(toastEl, { right: `${drawn.right}px`, bottom: `${drawn.bottom + LAUNCHER_SIZE + GAP}px` });
      if (open) setStyle(panel, panelPlacement(drawn, vw(), vh()));
    };
    const toast = (msg, isError = false) => {
      toastEl.textContent = msg;
      toastEl.dataset.kind = isError ? "error" : "ok";
      toastEl.dataset.show = "true";
      place();
      win.clearTimeout(toastTimer);
      toastTimer = win.setTimeout(() => {
        toastEl.dataset.show = "false";
      }, TOAST_MS);
    };
    const message = (text, cls, onClick) => {
      list.innerHTML = "";
      rows = [];
      const li = el("hci-row", `hci-row ${cls}`);
      li.textContent = text;
      if (onClick) li.addEventListener("click", onClick);
      list.appendChild(li);
    };
    const render = (rs, by, highlight) => {
      list.innerHTML = "";
      rows = rs;
      rs.forEach((r, i) => {
        const li = el("hci-row", "hci-row");
        li.setAttribute("role", "option");
        if (r.house.kurzwahl && r.full) li.title = "Click / Enter: Kurzwahl \xB7 Shift+click / Shift+Enter: full number";
        li.dataset.index = String(i);
        const t = rowText(r, by);
        if (t.strong) {
          const s = el("hci-strong");
          s.textContent = t.strong;
          li.appendChild(s);
        }
        li.appendChild(doc.createTextNode(t.text));
        if (t.second) {
          const sec = el("hci-second");
          sec.textContent = t.second;
          li.appendChild(sec);
        }
        if (i === highlight) li.dataset.highlight = "true";
        list.appendChild(li);
      });
    };
    const noData = () => message(deps.noDataText ?? "No contact list loaded. Click here to open the options and import one.", "hci-no-data", () => {
      doClose();
      deps.openOptions();
    });
    const showFullList = (by) => {
      sortBy = by;
      sortBar.dataset.hidden = "false";
      for (const [k, b] of sortBtns) b.dataset.active = String(k === by);
      if (!data) {
        noData();
        return;
      }
      render(sortedHouses(data, by), by, -1);
    };
    const runSearch = () => {
      const q = search.value.trim();
      if (!q) {
        showFullList(sortBy);
        return;
      }
      sortBar.dataset.hidden = "true";
      if (!data) {
        noData();
        return;
      }
      const found = searchRows(data, q).slice(0, MAX_RESULTS);
      if (!found.length) {
        message("No results", "hci-no-results");
        return;
      }
      const shown = found.reverse();
      render(shown, "search", shown.length - 1);
    };
    const highlighted = () => {
      const h = list.querySelector('[data-highlight="true"]');
      return h ? Number(h.dataset.index) : -1;
    };
    const move = (delta) => {
      const items = [...list.querySelectorAll("hci-row[data-index]")];
      if (!items.length) return;
      const cur = highlighted();
      const next = cur < 0 ? delta > 0 ? 0 : items.length - 1 : (cur + delta + items.length) % items.length;
      items.forEach((i) => delete i.dataset.highlight);
      items[next].dataset.highlight = "true";
      items[next].scrollIntoView?.({ block: "nearest" });
    };
    const pick = async (r, full = false) => {
      if (!r) return;
      doClose();
      const who = r.house.code || r.house.name;
      const number = full ? r.full : r.dial;
      if (!number) {
        toast(full ? `No full number for ${who}` : `No number for ${who}`, true);
        return;
      }
      let ok = false;
      try {
        ok = await deps.dial(number);
      } catch (e) {
        console.warn("[house-contact-index] dial failed:", e);
      }
      if (ok) toast(`Dialing ${number}`);
      else toast(`Dial field not found. Is the softphone open? (${number})`, true);
    };
    const doOpen = async () => {
      if (open) return;
      open = true;
      panel.dataset.open = "true";
      launcher.setAttribute("aria-expanded", "true");
      place();
      search.value = "";
      search.focus({ preventScroll: true });
      if (!loaded) {
        message("Loading\u2026", "hci-loading");
        try {
          data = await deps.loadData();
        } catch (e) {
          console.warn("[house-contact-index] could not load the contact list:", e);
          data = null;
        }
        loaded = true;
      }
      if (open) runSearch();
    };
    const doClose = (refocus = false) => {
      if (!open) return;
      open = false;
      panel.dataset.open = "false";
      launcher.setAttribute("aria-expanded", "false");
      if (refocus) launcher.focus({ preventScroll: true });
    };
    const toggle = () => {
      if (open) doClose();
      else void doOpen();
    };
    let press = null;
    let dragged = false;
    let suppressClick = false;
    launcher.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      press = { x: e.clientX, y: e.clientY, start: clampPos(pos, vw(), vh()), id: e.pointerId };
      dragged = false;
      launcher.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    launcher.addEventListener("pointermove", (e) => {
      if (!press) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragged = true;
      launcher.dataset.dragging = "true";
      pos = clampPos({ right: press.start.right - dx, bottom: press.start.bottom - dy }, vw(), vh());
      place();
    });
    const endPress = (e) => {
      if (!press) return;
      launcher.releasePointerCapture?.(press.id);
      press = null;
      delete launcher.dataset.dragging;
      if (dragged && e.type === "pointerup") {
        suppressClick = true;
        win.setTimeout(() => {
          suppressClick = false;
        }, 0);
        void savePosition(deps.storage, deps.siteKey, pos).catch(() => void 0);
      }
    };
    launcher.addEventListener("pointerup", endPress);
    launcher.addEventListener("pointercancel", endPress);
    launcher.addEventListener("click", (e) => {
      e.preventDefault();
      if (suppressClick || dragged) {
        suppressClick = false;
        dragged = false;
        return;
      }
      toggle();
    });
    launcher.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    sortBar.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-sort]");
      if (b) showFullList(b.dataset.sort);
    });
    list.addEventListener("click", (e) => {
      const li = e.target.closest("hci-row[data-index]");
      if (li) void pick(rows[Number(li.dataset.index)], e.shiftKey);
    });
    search.addEventListener("input", runSearch);
    search.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        void pick(rows[highlighted()], e.shiftKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        doClose(true);
      }
    });
    const onKey = (e) => {
      if (open && e.key === "Escape") doClose(true);
    };
    const onResize = () => place();
    doc.addEventListener("keydown", onKey, true);
    win.addEventListener("resize", onResize);
    panel.dataset.open = "false";
    toastEl.dataset.show = "false";
    launcher.setAttribute("aria-expanded", "false");
    place();
    doc.documentElement.append(panel, toastEl, launcher);
    const handle = {
      launcher,
      panel,
      search,
      list,
      isOpen: () => open,
      open: doOpen,
      close: () => doClose(),
      toggle,
      async resetPosition() {
        pos = { ...DEFAULT_POS };
        place();
        await resetPosition(deps.storage, deps.siteKey);
      },
      applyPositions(all) {
        if (press) return;
        const p = all[deps.siteKey];
        pos = isValidPos(p) ? { ...p } : { ...DEFAULT_POS };
        place();
      },
      // A new list was imported (or removed): reload on the next open, or now
      // if the popup is showing.
      dataChanged() {
        loaded = false;
        if (open) {
          open = false;
          void doOpen();
        }
      },
      toast,
      async offer(text, onClick) {
        await doOpen();
        sortBar.dataset.hidden = "true";
        message(text, "hci-no-data", () => {
          doClose();
          onClick();
        });
      },
      destroy() {
        doc.removeEventListener("keydown", onKey, true);
        win.removeEventListener("resize", onResize);
        win.clearTimeout(toastTimer);
        launcher.remove();
        panel.remove();
        toastEl.remove();
      }
    };
    return handle;
  }

  // src/gm-storage.ts
  function gmStorageArea(gm) {
    return {
      async get(key) {
        const v = gm.getValue(key, void 0);
        return v === void 0 ? {} : { [key]: v };
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) gm.setValue(k, v);
      }
    };
  }

  // src/store.ts
  var CONTACTS_KEY = "hci.contacts";
  async function loadContacts(storage) {
    const raw = (await storage.get(CONTACTS_KEY))[CONTACTS_KEY];
    if (!raw) return null;
    const parsed = parseContacts(raw);
    return parsed.ok ? parsed.data : null;
  }
  async function importContacts(storage, text) {
    const parsed = parseContacts(text);
    if (!parsed.ok) return parsed;
    await storage.set({ [CONTACTS_KEY]: parsed.data });
    return parsed;
  }
  async function clearContacts(storage) {
    await storage.set({ [CONTACTS_KEY]: null });
  }

  // src/dial.ts
  var DIAL_INPUT_ID = "dial-number-input";
  function fillInput(input, value) {
    const win = input.ownerDocument.defaultView ?? window;
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus();
  }
  function ownDialInput(doc) {
    const el = doc.getElementById(DIAL_INPUT_ID);
    return el && el.tagName === "INPUT" ? el : null;
  }
  function findDialInput(win) {
    try {
      const el = ownDialInput(win.document);
      if (el) return el;
      for (let i = 0; i < win.frames.length; i++) {
        const found = findDialInput(win.frames[i]);
        if (found) return found;
      }
    } catch {
    }
    return null;
  }
  function fillDialHere(win, value, deep = true) {
    const input = deep ? findDialInput(win) : ownDialInput(win.document);
    if (!input) return false;
    fillInput(input, value);
    return true;
  }

  // src/frame-relay.ts
  var FILL_POST = "hci.fill";
  var FILLED_POST = "hci.filled";
  var ACK_MS = 800;
  function allFrames(win) {
    const out = [];
    const walk = (w) => {
      let n = 0;
      try {
        n = w.frames.length;
      } catch {
        return;
      }
      for (let i = 0; i < n; i++) {
        let f;
        try {
          f = w.frames[i];
        } catch {
          continue;
        }
        if (!f) continue;
        out.push(f);
        walk(f);
      }
    };
    walk(win);
    return out;
  }
  var randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function makeFrameDial(win, opts = {}) {
    const ackMs = opts.ackMs ?? ACK_MS;
    const newId = opts.newId ?? randomId;
    return (number) => new Promise((resolve) => {
      const frames = allFrames(win);
      if (!frames.length) {
        resolve(false);
        return;
      }
      const id = newId();
      let timer = 0;
      const onMessage = (e) => {
        const d = e.data;
        if (d?.type === FILLED_POST && d.id === id) done(true);
      };
      const done = (ok) => {
        win.removeEventListener("message", onMessage);
        win.clearTimeout(timer);
        resolve(ok);
      };
      win.addEventListener("message", onMessage);
      timer = win.setTimeout(() => done(false), ackMs);
      const msg = { type: FILL_POST, id, number };
      for (const f of frames) {
        try {
          f.postMessage(msg, "*");
        } catch {
        }
      }
    });
  }
  function frameReceiver(win) {
    return (e) => {
      const d = e.data;
      if (d?.type !== FILL_POST || typeof d.id !== "string" || typeof d.number !== "string" || !d.number) return;
      if (!e.source || e.source !== win.top) return;
      if (!fillDialHere(win, d.number, false)) return;
      try {
        e.source.postMessage({ type: FILLED_POST, id: d.id }, e.origin && e.origin !== "null" ? e.origin : "*");
      } catch {
      }
    };
  }

  // src/read-file.ts
  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsText(file);
    });
  }

  // src/work-ai-prompt.ts
  var WORK_AI_PROMPT = `I need ONE JSON file built from TWO sources, which I will paste, attach or name below,
so I can import it into a browser tool. The output must follow this exact format and
contain nothing else.

THE TWO SOURCES
- SOURCE 1 \u2014 the Kurzwahl table: the houses with their Kurzwahl (the internal number,
  the one staff dial), usually under German city names.
- SOURCE 2 \u2014 the contact list: the houses with their full external phone number
  (and possibly house ID, house number, address and the internal number, often in
  bold), usually under local or English names.

FORMAT
{
  "kind": "house-contacts",
  "schemaVersion": 1,
  "generatedAt": "<today, YYYY-MM-DD>",
  "source": "<both sources, each with its as-of date, one line>",
  "houses": [ <one entry per house> ]
}

Each house \u2014 exactly these keys, no others:
{ "code": "<the house ID / house code exactly as written, e.g. XX-1>",
  "houseNumber": <the internal house number as a whole number, or null>,
  "name": "<house name, see rule 4>",
  "kurzwahl": "<the internal number, see rule 3: just the digits, no minus
               sign, e.g. \\"1234\\">",
  "phone": "<from SOURCE 2: the house's external phone number as written, as text>",
  "address": "<street, postcode, city>",
  "city": "<city, in German>",
  "country": "<ISO 2-letter country code, e.g. DE>",
  "aliases": [ <see rule 5> ] }

RULES
1. One entry per house that appears in either source. Do not invent houses.
2. Match the two sources by house code; if a source has no codes, by house name. Two
   entries with different codes are still the same house when they are in the same city
   and their names are the same once "a&o", "Hostel" and "Hotel" are left out: make one
   entry with SOURCE 1's code, add the other code to its aliases, and put it on the check
   list. Otherwise never guess a match: a house found in only one source still gets an
   entry, with null for what the other source would have given, and goes on the check
   list.
3. The Kurzwahl is the internal number. SOURCE 1 lists it. SOURCE 2 often lists it too,
   in bold: bold digits in SOURCE 2 are ALWAYS the internal number, also when they are
   part of the external phone number (a phone number "+351 21 555 4401" with "4401" in
   bold has the Kurzwahl 4401; the phone number stays as written). Gather every internal
   number both sources give for the house. If they are all the same, that is the
   Kurzwahl. If there are several or they differ, take the one that ends in 1; if none
   or more than one ends in 1, take SOURCE 1's first. Put every house where you chose on
   the check list, with all the numbers you saw. Write the Kurzwahl as just the digits:
   no minus sign, no spaces, no brackets. "(-4401)", "- 4401", "-4401" and a bold "4401"
   all become "4401".
4. The name: SOURCE 1's name, without "a&o", "Hostel" or "Hotel". If that name is only the
   city and SOURCE 2's name for the house adds a part that tells the houses apart (a
   district, a station, a street, "City", "Centrum", "Beach"), add that part as SOURCE 2
   writes it: "Lissabon" + "Lisboa Alfama" gives "Lissabon Alfama". If SOURCE 1's name
   already has such a part, keep SOURCE 1's name as it is ("Hbf" and "Hauptbahnhof" are
   the same part).
5. Aliases, so the house is found under every name staff use: the city in German, in
   English and in the local language when they differ ("Lissabon", "Lisbon", "Lisboa");
   SOURCE 2's name for the house when it differs from "name"; any other code from rule
   2; and other names or short names staff use. No duplicates.
6. ONE Kurzwahl and ONE phone number per house: the number you would call to reach the
   house, usually reception. Leave out everything else: emergency numbers, night or
   after-hours lines, managers, staff and personal numbers, fax, mobile numbers, email
   addresses, opening hours, notes. Do not add any key that is not in the format above.
7. Numbers are always text. The phone number is copied exactly (keep +, spaces).
8. Blank, unclear or contradictory values are null. Never guess and never fill in from
   general knowledge (no looking up addresses or phone numbers). The one exception is the
   city names in rule 5. If the two sources disagree on a house's code or address, use
   SOURCE 1's value (the Kurzwahl table) and put the house on the check list (for the
   Kurzwahl, rule 3 decides).
9. If I attach a previous version of this file, keep its codes and aliases where the
   house still exists, so my searches keep working.

OUTPUT
- The complete JSON as a downloadable file named house-contacts-<YYYY-MM-DD>.json.
  If you cannot create files, output it as one single \`\`\`json code block and nothing
  else inside that block. It must be valid JSON (no comments, no trailing commas).
- After the file: one short check list: number of houses; houses only in SOURCE 1;
  houses only in SOURCE 2; houses merged under different codes (rule 2); houses where
  you chose the Kurzwahl (rule 3), with every number you saw and the one you took; houses
  without a Kurzwahl; houses without a phone number; houses where the sources disagreed
  (rule 8) and on what; every null you set because a value was unclear (not just blank),
  with the reason.

SOURCE 1 \u2014 THE KURZWAHL TABLE
<paste it here, or attach it / name the page>

SOURCE 2 \u2014 THE CONTACT LIST
<paste it here, or attach it / name the page>`;

  // src/userscript.ts
  var LOG = "[house-contact-index]";
  function pickFile(doc, onFile) {
    doc.getElementById("hci-file-input")?.remove();
    const input = doc.createElement("input");
    input.id = "hci-file-input";
    input.type = "file";
    input.accept = "application/json,.json";
    input.hidden = true;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (file) onFile(file);
    });
    doc.documentElement.appendChild(input);
    input.click();
  }
  function startTop() {
    const storage = gmStorageArea({ getValue: GM_getValue, setValue: GM_setValue });
    const siteKey = siteKeyForUrl(location.href) ?? location.origin;
    const frameDial = makeFrameDial(window);
    let handle = null;
    const importFile = async (file) => {
      let text;
      try {
        text = await readFileText(file);
      } catch (e) {
        handle?.toast(`Import failed: could not read ${file.name}`, true);
        console.warn(LOG, "could not read", file.name, e);
        return;
      }
      const result = await importContacts(storage, text);
      if (!result.ok) {
        handle?.toast(`Import failed: ${result.error}. The previous list is unchanged.`, true);
        return;
      }
      for (const w of result.warnings) console.warn(LOG, "import:", w);
      handle?.dataChanged();
      handle?.toast(`Imported ${result.data.houses.length} houses` + (result.warnings.length ? ` (${result.warnings.length} warnings, see the console)` : ""));
    };
    const chooseFile = () => pickFile(document, (f) => {
      void importFile(f);
    });
    let style;
    const mount = async () => {
      if (!style?.isConnected) style = GM_addStyle(`/* The in-page launcher, popup and toast (src/launcher.ts). Injected by the
   browser alongside the content script, so a page CSP can't block it. Every
   rule is !important and starts from \`all: initial\`, because these elements
   live in the host page's DOM (the pattern of the interactive-knowledge-base
   extension's launcher.css).

   Flat look, tokens from ao-tools-shared DESIGN.md \xA72.1/\xA72.2: launcher 70\xD770
   #007BFF, 11px Arial label, z-index 999999; panel #222, 1px #444, radius
   10px, z-index 999998; rows/buttons/input #333 with 1px #555, radius 5px;
   highlight #007BFF; "No results" #3d0000 / #ff6b6b. Position and the
   panel's box are set from script through CSSOM. */

hci-launcher#hci-launcher,
hci-launcher#hci-launcher *,
hci-panel#hci-panel,
hci-panel#hci-panel *,
hci-toast {
  all: initial !important;
}

hci-launcher#hci-launcher {
  position: fixed !important;
  z-index: 999999 !important;
  width: 70px !important;
  height: 70px !important;
  box-sizing: border-box !important;
  border-radius: 50% !important;
  display: flex !important;
  flex-direction: column !important;
  justify-content: center !important;
  align-items: center !important;
  font: 11px/1.3 Arial, sans-serif !important;
  text-align: center !important;
  cursor: pointer !important;
  user-select: none !important;
  -webkit-user-select: none !important;
  touch-action: none !important;
  background: #007BFF !important;
  color: #fff !important;
  transition: background 0.3s !important;
}
hci-launcher#hci-launcher:hover { background: #0056b3 !important; }
hci-launcher#hci-launcher[data-dragging="true"] { cursor: grabbing !important; }
hci-launcher#hci-launcher:focus-visible { outline: 2px solid #fff !important; outline-offset: 2px !important; }
hci-launcher#hci-launcher hci-line {
  display: block !important;
  font: inherit !important;
  color: inherit !important;
  pointer-events: none !important;
}

hci-panel#hci-panel {
  position: fixed !important;
  z-index: 999998 !important;
  box-sizing: border-box !important;
  display: flex !important;
  flex-direction: column !important;
  padding: 10px !important;
  background: #222 !important;
  border: 1px solid #444 !important;
  border-radius: 10px !important;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.6) !important;
  font: 14px Arial, sans-serif !important;
  color: #fff !important;
}
hci-panel#hci-panel[data-open="false"] { display: none !important; }

hci-panel#hci-panel hci-list-box {
  display: block !important;
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-y: auto !important;
  margin-bottom: 10px !important;
}
/* ao-tools-ui.js: the list has its own 10px padding inside the panel's 10px. */
hci-panel#hci-panel hci-list { display: block !important; box-sizing: border-box !important; padding: 10px !important; }
hci-panel#hci-panel hci-row {
  display: block !important;
  box-sizing: border-box !important;
  padding: 10px !important;
  margin-bottom: 5px !important;
  background: #333 !important;
  color: #fff !important;
  border: 1px solid #555 !important;
  border-radius: 5px !important;
  font: 14px Arial, sans-serif !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  cursor: pointer !important;
  transition: background 0.3s !important;
}
hci-panel#hci-panel hci-row:hover,
hci-panel#hci-panel hci-row[data-highlight="true"] { background: #007BFF !important; }
hci-panel#hci-panel hci-row hci-strong { display: inline !important; font: bold 14px Arial, sans-serif !important; color: inherit !important; }
hci-panel#hci-panel hci-row hci-second {
  display: block !important;
  font: inherit !important;
  color: inherit !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
hci-panel#hci-panel hci-row.hci-no-results {
  background: #3d0000 !important;
  color: #ff6b6b !important;
  font-style: italic !important;
  text-align: center !important;
  cursor: default !important;
}
hci-panel#hci-panel hci-row.hci-no-results:hover { background: #3d2000 !important; }
hci-panel#hci-panel hci-row.hci-no-data { white-space: normal !important; color: #ffc107 !important; }
hci-panel#hci-panel hci-row.hci-loading { color: #aaa !important; cursor: default !important; }

hci-panel#hci-panel hci-sort {
  display: flex !important;
  flex-shrink: 0 !important;
  gap: 5px !important;
  margin-bottom: 10px !important;
}
hci-panel#hci-panel hci-sort[data-hidden="true"] { display: none !important; }
hci-panel#hci-panel button.hci-sort-btn {
  display: block !important;
  flex: 1 !important;
  height: 48px !important;
  padding: 10px !important;
  box-sizing: border-box !important;
  background: #333 !important;
  color: #fff !important;
  border: 1px solid #555 !important;
  border-radius: 5px !important;
  font: 12px/1.2 Arial, sans-serif !important;
  text-align: center !important;
  cursor: pointer !important;
  transition: background 0.3s !important;
}
hci-panel#hci-panel button.hci-sort-btn[data-active="true"] { background: #007BFF !important; }
hci-panel#hci-panel button.hci-sort-btn:hover { background: #0056b3 !important; }
hci-panel#hci-panel button.hci-sort-btn hci-line { display: block !important; font: inherit !important; color: inherit !important; text-align: center !important; pointer-events: none !important; }

hci-panel#hci-panel input#hci-search {
  display: block !important;
  flex-shrink: 0 !important;
  box-sizing: border-box !important;
  width: 100% !important;
  height: 48px !important;
  padding: 10px !important;
  background: #333 !important;
  color: #fff !important;
  border: 1px solid #555 !important;
  border-radius: 5px !important;
  font: 14px Arial, sans-serif !important;
  cursor: text !important;
}
hci-panel#hci-panel input#hci-search:focus { outline: 2px solid #007BFF !important; outline-offset: -1px !important; }
hci-panel#hci-panel button:focus-visible { outline: 2px solid #007BFF !important; outline-offset: 1px !important; }

hci-toast {
  position: fixed !important;
  z-index: 9999999 !important;
  display: block !important;
  padding: 8px 14px !important;
  border-radius: 6px !important;
  background: #27ae60 !important;
  color: #fff !important;
  font: 13px Arial, sans-serif !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5) !important;
  pointer-events: none !important;
}
hci-toast[data-kind="error"] { background: #c0392b !important; }
hci-toast[data-show="false"] { display: none !important; }
`);
      const positions = await loadPositions(storage);
      handle?.destroy();
      handle = mountLauncher({
        storage,
        siteKey,
        position: positions[siteKey],
        loadData: () => loadContacts(storage),
        dial: async (number) => fillDialHere(window, number) || frameDial(number),
        openOptions: chooseFile,
        noDataText: "No contact list loaded. Click here to import the house-contacts file."
      });
    };
    void (async () => {
      await mount();
      GM_addValueChangeListener(CONTACTS_KEY, (_k, _o, _n, remote) => {
        if (remote) handle?.dataChanged();
      });
      GM_addValueChangeListener(LAUNCHER_POS_KEY, (_k, _o, n, remote) => {
        if (remote) handle?.applyPositions(n ?? {});
      });
      GM_registerMenuCommand("Import contact list\u2026", () => {
        void handle?.offer("Click here to choose the house-contacts file.", chooseFile);
      });
      GM_registerMenuCommand("Remove contact list", () => {
        if (!window.confirm("Remove the contact list from this browser?")) return;
        void clearContacts(storage).then(() => {
          handle?.dataChanged();
          handle?.toast("Contact list removed from this browser.");
        });
      });
      GM_registerMenuCommand("Copy work-AI prompt", () => {
        GM_setClipboard(WORK_AI_PROMPT, "text");
        handle?.toast("Work-AI prompt copied.");
      });
      GM_registerMenuCommand("Reset launcher position", () => {
        void handle?.resetPosition();
      });
      GM_registerMenuCommand("Restart Script", () => {
        console.info(LOG, "restarting");
        void mount().then(() => handle?.toast("House contact index restarted."));
      });
    })();
  }
  if (typeof window !== "undefined" && !globalThis.__hciUserscript) {
    globalThis.__hciUserscript = true;
    if (window === window.top) startTop();
    else window.addEventListener("message", frameReceiver(window));
  }
})();
