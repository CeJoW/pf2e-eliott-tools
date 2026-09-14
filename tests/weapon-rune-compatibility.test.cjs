const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const read = (path) => readFileSync(join(__dirname, "..", path), "utf8");
const featureSource = read("scripts/features/weapon-rune-compatibility.js");
const nativeSource = process.env.PF2E_RUNE_TEST_SOURCE
  ? readFileSync(process.env.PF2E_RUNE_TEST_SOURCE, "utf8") : null;

function setup({ enabled = true, ready = true, owner = true } = {}) {
  const notifications = [];
  const hooks = new Map();
  const runeData = Object.fromEntries(["flaming", "greaterDecaying", "greaterThundering", "greaterBrilliant"].map(
    (slug) => [slug, { name: slug, strikeAdjustments: [{ slug }] }],
  ));
  const config = { baseWeaponTypes: { dagger: "Dagger" }, baseShieldTypes: {}, preciousMaterials: {} };
  const localize = (key, params) => {
    if (params && key.includes("GeneratedName")) return `${params.property1} ${params.base}`;
    return key;
  };
  // The failing native lookup occurs before any adjustment mutates the weapon.
  function getPropertyRuneStrikeAdjustments(runes) {
    return runes.flatMap((slug) => runeData[slug].strikeAdjustments ?? []);
  }
  let lookup = getPropertyRuneStrikeAdjustments;
  let generateItemName = (item) => {
    const rune = runeData[item.system.runes.property[0]];
    return rune?.name ? `${rune.name} ${item.name}` : item.name;
  };
  // Optional integration run uses the two actual PF2e 8.5.0 functions.
  if (nativeSource) {
    const native = vm.runInNewContext(`${nativeSource}\n({getPropertyRuneStrikeAdjustments, generateItemName})`, {
      RUNE_DATA: { weapon: { property: runeData, striking: {} } }, CONFIG: { PF2E: config },
      _loc: localize, R: { isTruthy: Boolean },
    });
    lookup = native.getPropertyRuneStrikeAdjustments;
    generateItemName = native.generateItemName;
  }
  class Character {
    constructor() { this.name = "Test"; this.uuid = "Actor.test"; this.isOwner = owner; }
    prepareStrike(weapon, options) {
      const adjustments = lookup(weapon.system.runes.property);
      return { item: weapon, adjustments, options, potency: weapon.system.runes.potency };
    }
    prepareData(weapons) {
      this.attacks = weapons.map((weapon) => this.prepareStrike(weapon, { handsReallyFree: 1 }));
      this.spellDC = 33; // PF2e prepares spell statistics only after attacks succeed
    }
  }
  config.Actor = { documentClasses: { character: Character } };
  const context = vm.createContext({
    CONFIG: { PF2E: config },
    game: { ready, user: { isGM: false }, settings: { get: () => enabled },
      i18n: { localize }, pf2e: { system: { generateItemName } } },
    Hooks: { once: (name, fn) => hooks.set(name, fn) },
    foundry: { utils: { escapeHTML: (text) => text.replaceAll("<", "&lt;").replaceAll(">", "&gt;") } },
    ui: { notifications: { warn: (text) => notifications.push(text) } },
    console: { warn() {} },
  });
  vm.runInContext(read("scripts/module/context.js"), context);
  vm.runInContext(featureSource, context);
  const feature = context.pf2eEliottTools.features.weaponRuneCompatibility;
  feature.onInit();
  const weapon = (runes, id = "scythe") => {
    const source = { system: { runes: { property: runes, potency: 4, striking: 4 } } };
    return { id, name: "Imported scythe", _source: structuredClone(source), system: structuredClone(source.system) };
  };
  return { Character, actor: new Character(), weapon, feature, context, notifications, hooks, runeData };
}

test("imported siccatite rune cannot prevent other attacks and spell DC preparation", () => {
  const env = setup();
  const originalRunes = ["greaterSiccatiteFrost", "greaterDecaying", "greaterThundering", "greaterBrilliant"];
  const scythe = env.weapon(originalRunes);
  const bow = env.weapon(["flaming"], "bow");
  env.actor.prepareData([scythe, bow]);
  assert.equal(env.actor.spellDC, 33);
  assert.equal(env.actor.attacks.length, 2);
  assert.deepEqual(Array.from(scythe.system.runes.property), originalRunes.slice(1));
  assert.deepEqual(scythe._source.system.runes.property, originalRunes);
  assert.equal(env.actor.attacks[0].adjustments.length, 3);
  assert.equal(env.actor.attacks[0].potency, 4);
  assert.equal(scythe.system.runes.striking, 4);
  assert.equal(env.actor.attacks[0].options.handsReallyFree, 1);
  assert.match(env.notifications[0], /greaterSiccatiteFrost/);
});

test("supported core and registered custom runes pass through without a probe or warning", () => {
  const env = setup();
  env.runeData.customRune = { name: "Custom rune", strikeAdjustments: [{ custom: true }] };
  env.context.game.pf2e.system.generateItemName = () => { throw new Error("should not probe healthy strikes"); };
  const weapon = env.weapon(["customRune", "flaming"]);
  const originalList = weapon.system.runes.property;
  const strike = env.actor.prepareStrike(weapon);
  assert.equal(strike.adjustments.length, 2);
  assert.equal(weapon.system.runes.property, originalList);
  assert.equal(env.notifications.length, 0);
});

test("all unknown properties are excluded without weakening fundamental runes", () => {
  const env = setup();
  const weapon = env.weapon(["missing-a", "missing-b"]);
  const strike = env.actor.prepareStrike(weapon);
  assert.equal(strike.adjustments.length, 0);
  assert.equal(strike.potency, 4);
  assert.equal(weapon.system.runes.striking, 4);
  assert.deepEqual(weapon._source.system.runes.property, ["missing-a", "missing-b"]);
});

test("a previously missing rune works again after its provider registers it and the actor resets", () => {
  const env = setup();
  const weapon = env.weapon(["greaterSiccatiteFrost", "flaming"]);
  env.actor.prepareStrike(weapon);
  env.runeData.greaterSiccatiteFrost = { name: "Siccatite frost", strikeAdjustments: [{ restored: true }] };
  weapon.system = structuredClone(weapon._source.system);
  assert.equal(env.actor.prepareStrike(weapon).adjustments.length, 2);
  assert.deepEqual(weapon.system.runes.property, ["greaterSiccatiteFrost", "flaming"]);
});

test("warnings wait until ready, respect ownership, escape names and do not repeat on resets", () => {
  const env = setup({ ready: false });
  env.actor.name = "<Test>";
  const weapon = env.weapon(["missing"]);
  env.actor.prepareStrike(weapon);
  assert.equal(env.notifications.length, 0);
  env.hooks.get("ready")();
  assert.match(env.notifications[0], /&lt;Test&gt;/);
  weapon.system = structuredClone(weapon._source.system);
  env.actor.prepareStrike(weapon);
  env.hooks.get("ready")();
  assert.equal(env.notifications.length, 1);
  const unowned = setup({ owner: false });
  unowned.actor.prepareStrike(unowned.weapon(["missing"]));
  assert.equal(unowned.notifications.length, 0);
});

test("unrelated errors and disabled compatibility retain the native failure", () => {
  const env = setup({ enabled: false });
  assert.throws(() => env.actor.prepareStrike(env.weapon(["missing"])), /strikeAdjustments/);
  const enabledEnv = setup();
  Object.defineProperty(enabledEnv.runeData, "broken", { get() { throw new Error("unrelated"); } });
  assert.throws(() => enabledEnv.actor.prepareStrike(enabledEnv.weapon(["broken"])), /unrelated/);
});

test("an incompatible name-generator override cannot cause wholesale rune removal", () => {
  const env = setup();
  env.context.game.pf2e.system.generateItemName = () => "always the same";
  const weapon = env.weapon(["missing", "flaming"]);
  assert.throws(() => env.actor.prepareStrike(weapon), /strikeAdjustments/);
  assert.deepEqual(weapon.system.runes.property, ["missing", "flaming"]);
});

test("initialization does not wrap preparation twice", () => {
  const env = setup();
  const original = env.Character.prototype.prepareStrike;
  env.feature.onInit();
  assert.equal(env.Character.prototype.prepareStrike, original);
});
