const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const read = (path) => readFileSync(join(__dirname, "..", path), "utf8");
const moduleId = "pf2e-eliott-tools";

function setup({ level = 9, feat = true, enabled = true, generation = 14, version = "8.5.0" } = {}) {
  const hooks = new Map();
  const warnings = [];
  const updates = [];
  const casts = [];
  const drops = [];
  class Modifier {
    constructor(data) { Object.assign(this, data); }
  }
  // Model the PF2e Statistic contract: an explicit proficiency modifier replaces
  // the rank-generated modifier; rank null must not generate an untrained bonus.
  class Statistic {
    constructor(actor, data, config = {}) {
      this.actor = actor;
      this.data = data;
      this.config = config;
      this.rank = data.rank;
      this.base = null;
      if (data.attribute && !data.modifiers.some((m) => m.type === "ability" && m.ability === data.attribute)) {
        data.modifiers.push(new Modifier({ type: "ability", ability: data.attribute,
          modifier: actor.system.abilities[data.attribute].mod }));
      }
      this.modifiers = data.modifiers;
      const mod = data.modifiers.reduce((sum, modifier) => sum + modifier.modifier, 0);
      this.check = { mod };
      this.dc = { value: 10 + mod };
    }
    getChatData() { return { rank: this.rank, check: this.check, dc: this.dc }; }
  }
  const actor = {
    type: "character", level, isOwner: true,
    itemTypes: { feat: feat ? [{ slug: "mythic-magic" }] : [], spell: [], spellcastingEntry: [] },
    items: new Map(),
    flags: { pf2e: { rollOptions: { all: {} } } },
    system: { resources: { mythicPoints: { value: 3, max: 3 } }, attributes: {},
      abilities: { str: { mod: 6 }, dex: { mod: 3 }, con: { mod: 2 }, int: { mod: 3 }, wis: { mod: 2 }, cha: { mod: 4 } } },
    async update(data) {
      updates.push(data);
      this.system.resources.mythicPoints.value = data["system.resources.mythicPoints.value"];
      return this;
    },
  };
  class Entry {
    constructor({ marked = true, category = "innate", id = "entry" } = {}) {
      this.actor = actor;
      this.id = id;
      this.type = "spellcastingEntry";
      this.flags = { [moduleId]: { mythicMagic: marked } };
      this.system = { prepared: { value: category }, proficiency: { value: 2 }, ability: { value: "cha" }, tradition: { value: "arcane" } };
      this._source = { system: structuredClone(this.system) };
      actor.items.set(id, this);
      actor.itemTypes.spellcastingEntry.push(this);
    }
    get tradition() { return this.system.tradition.value || (this.system.prepared.value === "items" ? null : "arcane"); }
    getRollOptions(prefix = this.type) {
      return [`${prefix}:attribute:${this.system.ability.value}`, `${prefix}:category:${this.system.prepared.value}`,
        `${prefix}:${this.tradition}`, `${prefix}:tradition:${this.tradition}`];
    }
    prepareActorData() {
      if (this.spells?.contents.length) {
        actor.flags.pf2e.rollOptions.all["self:caster"] = true;
        actor.flags.pf2e.rollOptions.all[`self:caster:tradition:${this.tradition}`] = true;
      }
    }
    prepareStatistic() {
      this.statistic = new Statistic(actor, {
        slug: "test-spells", rank: 2, attribute: this.system.ability.value,
        domains: ["all", "spell-attack-dc"],
        rollOptions: this.getRollOptions("spellcasting"),
        modifiers: [new Modifier({ type: "proficiency", modifier: actor.level + 4 }),
          new Modifier({ type: "ability", ability: this.system.ability.value,
            modifier: actor.system.abilities[this.system.ability.value].mod }),
          new Modifier({ type: "status", modifier: -1 })],
        check: { domains: [`${this.tradition}-spell-attack`, "spell-attack", "attack-roll"] },
        dc: { domains: [`${this.tradition}-spell-dc`, "spell-dc"] },
      });
      this.statistic.base = { slug: "base-spellcasting" };
      actor.system.attributes.spellDC = { value: this.statistic.dc.value };
    }
    prepareSiblingData() {
      this.spells = {
        contents: actor.itemTypes.spell.filter((s) => s.system.location.value === this.id),
        async addSpell(spell, options) {
          drops.push({ spell, options });
          return spell;
        },
      };
    }
    async getSheetData() {
      return { id: this.id, category: this.system.prepared.value, isInnate: true,
        showSlotlessRanks: false, groups: [{ id: "cantrips" }, { id: 1 }, { id: 5 }],
        statistic: this.statistic?.getChatData() };
    }
    async cast(spell, options = {}) {
      casts.push({ spell, options });
      return "cast";
    }
  }
  class Spell {
    constructor({ baseRank = 1, location = "entry", cantrip = false, focus = false, ritual = false } = {}) {
      this.actor = actor;
      this.id = `spell-${actor.itemTypes.spell.length}`;
      this.name = this.id;
      this.sort = 0;
      this.baseRank = baseRank;
      this.isCantrip = cantrip;
      this.isFocusSpell = focus;
      this.isRitual = ritual;
      this._source = { system: { location: { value: location, heightenedLevel: baseRank } } };
      this.system = structuredClone(this._source.system);
      actor.itemTypes.spell.push(this);
    }
    prepareBaseData() { this.rankWhenPrepared = this.system.location.heightenedLevel; }
  }
  const context = vm.createContext({
    game: { release: { generation }, system: { version }, settings: { get: () => enabled }, pf2e: { Modifier } },
    CONFIG: { PF2E: { Item: { documentClasses: { spellcastingEntry: Entry, spell: Spell } } } },
    foundry: { utils: { deepClone: (data) => structuredClone(data) } },
    Hooks: { on: (name, fn) => hooks.set(name, fn) },
    ui: { notifications: { warn: (text) => warnings.push(text) } },
    console,
  });
  vm.runInContext(read("scripts/module/context.js"), context);
  vm.runInContext(read("scripts/features/mythic-magic.js"), context);
  const feature = context.pf2eEliottTools.features.mythicMagic;
  feature.onInit();
  return { actor, Entry, Spell, feature, context, warnings, updates, casts, drops, hooks,
    setEnabled: (value) => { enabled = value; } };
}

test("mythic proficiency replaces expert proficiency for attack and DC, preserving other modifiers", () => {
  const { Entry, actor } = setup();
  const entry = new Entry();
  entry.prepareStatistic();
  assert.equal(entry.statistic.check.mod, 22); // level 9 + 10 + Charisma 4 - frightened 1
  assert.equal(entry.statistic.dc.value, 32);
  assert.equal(entry.statistic.modifiers.filter((m) => m.type === "proficiency").length, 1);
  assert.equal(entry.statistic.data.rollOptions.includes("proficiency:mythic"), true);
  assert.equal(entry.statistic.data.attribute, "cha");
  assert.equal(entry.statistic.base.slug, "base-spellcasting");
  assert.equal(entry.system.proficiency.value, 2);
  assert.equal(actor.system.attributes.spellDC.value, 26); // other abilities cannot inherit mythic DC
});

test("only the flagged innate entry is changed; prepared, focus, NPC and ordinary magic stay native", () => {
  const { Entry, actor } = setup();
  for (const options of [{ marked: false }, { category: "prepared" }, { category: "focus" }]) {
    const entry = new Entry(options);
    entry.prepareStatistic();
    assert.equal(entry.statistic.check.mod, 16);
  }
  actor.type = "npc";
  const entry = new Entry();
  entry.prepareStatistic();
  assert.equal(entry.statistic.check.mod, 16);
});

test("heightening occurs before spell area preparation and never writes to the saved spell", () => {
  const { Entry, Spell, actor, setEnabled } = setup();
  new Entry();
  const spell = new Spell();
  for (const [level, rank] of [[8, 4], [9, 5], [14, 7], [20, 10], [8, 4]]) {
    actor.level = level;
    spell.system = structuredClone(spell._source.system);
    spell.prepareBaseData();
    assert.equal(spell.rankWhenPrepared, rank);
    assert.equal(spell._source.system.location.heightenedLevel, 1);
  }
  setEnabled(false);
  spell.system = structuredClone(spell._source.system);
  spell.prepareBaseData();
  assert.equal(spell.rankWhenPrepared, 1);
});

test("cantrips, focus spells, rituals and spells above the available rank cannot enter mythic magic", async () => {
  const { Entry, Spell, warnings, drops } = setup();
  const entry = new Entry();
  entry.prepareSiblingData();
  for (const options of [{ cantrip: true }, { focus: true }, { ritual: true }, { baseRank: 6 }]) {
    const spell = new Spell(options);
    spell.prepareBaseData();
    assert.equal(spell.rankWhenPrepared, spell.baseRank);
    assert.equal(await entry.spells.addSpell(spell), null);
  }
  assert.equal(warnings.length, 4);
  assert.equal(drops.length, 0);
});

test("sheet, browser and header drops always heighten to the current highest rank", async () => {
  const { Entry, Spell, actor, drops } = setup();
  const entry = new Entry();
  entry.prepareSiblingData();
  const spell = new Spell();
  for (const groupId of [undefined, 1, 3, 10]) await entry.spells.addSpell(spell, { groupId });
  assert.deepEqual(drops.map((d) => d.options.groupId), [5, 5, 5, 5]);
  actor.level = 11;
  await entry.spells.addSpell(spell);
  assert.equal(drops.at(-1).options.groupId, 6);
});

test("an empty entry still displays exactly one rank, and existing spells survive regrouping", async () => {
  const { Entry, Spell } = setup();
  const entry = new Entry();
  entry.prepareSiblingData();
  let data = await entry.getSheetData();
  assert.deepEqual(Array.from(data.groups, (g) => g.id), [5]);
  assert.equal(data.showSlotlessRanks, true);
  assert.equal(data.isInnate, false);
  assert.equal(data.groups[0].active.length, 0);
  const first = new Spell({ baseRank: 1 });
  const second = new Spell({ baseRank: 2 });
  entry.prepareSiblingData();
  data = await entry.getSheetData();
  assert.deepEqual(Array.from(data.groups[0].active, (s) => s.spell), [first, second]);
  assert.ok(data.groups[0].active.every((s) => s.castRank === 5 && !s.expended && !s.uses));
  assert.equal(data.groups[0].uses, undefined);
});

test("casting spends one mythic point, uses maximum rank and delegates the normal chat card", async () => {
  const { Entry, Spell, updates, casts } = setup();
  const entry = new Entry();
  const spell = new Spell();
  spell.atWill = true; // innate at-will cannot bypass the mythic cost
  assert.equal(await entry.cast(spell, { rank: 1, messageMode: "gmroll" }), "cast");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]["system.resources.mythicPoints.value"], 2);
  assert.equal(casts[0].options.consume, false);
  assert.equal(casts[0].options.rank, 5);
  assert.equal(casts[0].options.messageMode, "gmroll");
});

test("zero points blocks casting; an explicit non-consuming preview preserves resources", async () => {
  const { Entry, Spell, actor, updates, casts, warnings } = setup();
  const entry = new Entry();
  const spell = new Spell();
  actor.system.resources.mythicPoints.value = 0;
  await entry.cast(spell);
  assert.equal(casts.length, 0);
  assert.equal(warnings.length, 1);
  await entry.cast(spell, { consume: false, message: false });
  assert.equal(updates.length, 0);
  assert.equal(casts.length, 1);
  assert.equal(casts[0].options.message, false);
});

test("rapid repeated clicks cannot spend the same point twice", async () => {
  const { Entry, Spell, updates, casts } = setup();
  const entry = new Entry();
  const spell = new Spell();
  await Promise.all([entry.cast(spell), entry.cast(spell)]);
  assert.equal(updates.length, 1);
  assert.equal(casts.length, 1);
});

test("failed resource update does not create a card and releases the cast guard", async () => {
  const { Entry, Spell, actor, casts } = setup();
  const entry = new Entry();
  const spell = new Spell();
  const update = actor.update;
  actor.update = async () => { throw new Error("update failed"); };
  await assert.rejects(entry.cast(spell), /update failed/);
  assert.equal(casts.length, 0);
  actor.update = update;
  await entry.cast(spell);
  assert.equal(casts.length, 1);
});

test("removing the feat restores native data and prevents casting from the marked entry", async () => {
  const { Entry, Spell, actor, casts } = setup();
  const entry = new Entry();
  const spell = new Spell();
  actor.itemTypes.feat = [];
  entry.prepareStatistic();
  spell.prepareBaseData();
  assert.equal(entry.statistic.check.mod, 16);
  assert.equal(spell.rankWhenPrepared, 1);
  assert.equal((await entry.getSheetData()).groups.length, 3);
  await entry.cast(spell);
  assert.equal(casts.length, 0);
});

test("translated feats are recognized by source UUID and unrelated spells cannot borrow mythic casting", async () => {
  const { Entry, Spell, actor, casts } = setup({ feat: false });
  actor.itemTypes.feat.push({ sourceId: "Compendium.pf2e.feats-srd.Item.d605yhbRoaVgisFG" });
  const entry = new Entry();
  entry.prepareStatistic();
  assert.equal(entry.statistic.check.mod, 22);
  await entry.cast(new Spell({ location: "another-entry" }));
  assert.equal(casts.length, 0);
});

test("disabled and older-system worlds retain the original methods and no sheet hook", () => {
  for (const options of [{ enabled: false }, { generation: 13 }, { version: "7.7.0" }]) {
    const { Entry, hooks } = setup(options);
    const entry = new Entry();
    entry.prepareStatistic();
    assert.equal(entry.statistic.check.mod, 16);
    assert.equal(hooks.size, 0);
  }
});

test("initialization is idempotent and repeated actor preparation cannot stack proficiency", () => {
  const { Entry, feature } = setup();
  const prepare = Entry.prototype.prepareStatistic;
  feature.onInit();
  assert.equal(Entry.prototype.prepareStatistic, prepare);
  const entry = new Entry();
  for (let i = 0; i < 3; i++) {
    entry.prepareStatistic();
    assert.equal(entry.statistic.check.mod, 22);
  }
});

test("physical attributes and class DC links cannot supply Mythic Magic's spell attack or DC", () => {
  const { Entry, actor } = setup();
  for (const attribute of ["str", "dex", "con"]) {
    const entry = new Entry();
    entry._source.system.ability.value = attribute;
    entry._source.system.proficiency.slug = "fighter";
    entry.system = structuredClone(entry._source.system);
    entry.prepareStatistic();
    assert.equal(entry.statistic.data.attribute, "cha");
    assert.equal(entry.statistic.check.mod, actor.level + 10 + 4 - 1);
    assert.equal(entry.system.proficiency.slug, "");
    assert.equal(entry._source.system.ability.value, attribute, "normalization never overwrites saved data");
    assert.equal(entry._source.system.proficiency.slug, "fighter");
  }
});

test("all three mental attributes work, and missing selections fall back to class casting then Charisma", () => {
  const { Entry, actor } = setup();
  const entry = new Entry();
  for (const attribute of ["int", "wis", "cha"]) {
    entry._source.system.ability.value = attribute;
    entry.prepareStatistic();
    assert.equal(entry.statistic.data.attribute, attribute);
    assert.equal(entry.statistic.check.mod, actor.level + 10 + actor.system.abilities[attribute].mod - 1);
  }
  entry._source.system.ability.value = "";
  actor.itemTypes.spellcastingEntry.push({ isPrepared: true, attribute: "wis" });
  entry.prepareStatistic();
  assert.equal(entry.statistic.data.attribute, "wis");
});

test("mythic edit dialog has only mental attributes and a fixed mythic proficiency", () => {
  const { Entry, hooks, context } = setup();
  const entry = new Entry();
  entry._source.system.ability.value = "str";
  const ability = { options: [], value: "str", disabled: true };
  for (const value of ["str", "dex", "con", "int", "wis", "cha"]) {
    ability.options.push({ value, remove() { ability.options.splice(ability.options.indexOf(this), 1); } });
  }
  const proficiency = { options: [{ value: "fighter" }], value: "fighter", disabled: true,
    replaceChildren(option) { this.options = [option]; } };
  const group = { removed: false, remove() { this.removed = true; } };
  const tradition = { value: "arcane", disabled: false, closest: () => group };
  const root = { querySelector: (selector) => selector.includes("proficiency") ? proficiency
    : selector.includes("tradition") ? tradition : ability };
  context.document = { createElement: () => ({}) };
  hooks.get("renderSpellcastingCreateAndEditDialog")({ object: entry }, root);
  assert.deepEqual(ability.options.map((option) => option.value), ["int", "wis", "cha"]);
  assert.equal(ability.disabled, false);
  assert.equal(ability.value, "cha");
  assert.equal(proficiency.options.length, 1);
  assert.equal(proficiency.options[0].textContent, "Мифическое");
  assert.equal(proficiency.value, "");
  assert.equal(proficiency.disabled, false, "the empty proficiency slug must be submitted");
  assert.equal(tradition.disabled, true, "a hidden tradition must not be submitted");
  assert.equal(group.removed, true);
  assert.equal(entry._source.system.tradition.value, "arcane", "editing does not erase the saved tradition");
});

test("mythic casting has no fixed tradition or tradition-specific calculation selectors", () => {
  const { Entry } = setup();
  const entry = new Entry();
  for (const tradition of ["arcane", "divine", "occult", "primal", ""]) {
    entry.system.tradition.value = tradition;
    assert.equal(entry.tradition, null);
    entry.prepareStatistic();
    assert.equal(entry.statistic.data.label, "Мифическая магия");
    assert.deepEqual(Array.from(entry.statistic.data.check.domains), ["spell-attack", "attack-roll"]);
    assert.deepEqual(Array.from(entry.statistic.data.dc.domains), ["spell-dc"]);
    assert.ok(!entry.statistic.data.rollOptions.some((option) => /arcane|divine|occult|primal|null/.test(option)));
    assert.deepEqual(Array.from(entry.getRollOptions("custom")), ["custom:attribute:cha", "custom:category:innate"]);
    assert.equal(entry.statistic.dc.value, 32);
  }
});

test("mythic preparation does not declare a caster tradition and preserves other entries' traditions", () => {
  const { Entry, Spell, actor } = setup();
  const entry = new Entry();
  new Spell();
  entry.prepareSiblingData();
  const options = actor.flags.pf2e.rollOptions.all;
  options["self:caster:tradition:primal"] = true;
  entry.prepareActorData();
  assert.deepEqual(options, { "self:caster": true, "self:caster:tradition:primal": true });
  const ordinary = new Entry({ marked: false });
  ordinary.prepareSiblingData();
  ordinary.prepareActorData();
  assert.equal(options["self:caster:tradition:arcane"], true);
});

test("turning off mythic mode restores the stored tradition and ordinary calculation selectors", () => {
  for (const disable of [({ entry }) => { entry.flags[moduleId].mythicMagic = false; },
    ({ actor }) => { actor.itemTypes.feat = []; }, ({ setEnabled }) => setEnabled(false)]) {
    const setupData = setup();
    const entry = new setupData.Entry();
    entry.system.tradition.value = "occult";
    entry._source.system.tradition.value = "occult";
    assert.equal(entry.tradition, null);
    disable({ ...setupData, entry });
    assert.equal(entry.tradition, "occult");
    assert.equal(entry._source.system.tradition.value, "occult");
    entry.prepareStatistic();
    assert.ok(entry.statistic.data.check.domains.includes("occult-spell-attack"));
    assert.ok(entry.statistic.data.dc.domains.includes("occult-spell-dc"));
    assert.ok(entry.getRollOptions().includes("spellcastingEntry:tradition:occult"));
  }
});

test("ordinary spellcasting dialogs and calculations retain PF2e's physical-attribute support", () => {
  const { Entry, hooks } = setup();
  const entry = new Entry({ marked: false });
  entry.system.ability.value = "str";
  entry.prepareStatistic();
  assert.equal(entry.statistic.data.attribute, "str");
  hooks.get("renderSpellcastingCreateAndEditDialog")({ object: entry }, {
    querySelector() { throw new Error("ordinary dialog must not be changed"); },
  });
});
