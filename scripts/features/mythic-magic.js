(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const flag = "mythicMagic";
  const flagPath = `flags.${moduleId}.${flag}`;
  const label = "Мифическая магия";
  const mentalAttributes = ["int", "wis", "cha"];
  const castingActors = new WeakSet();
  let installed = false;

  tools.features ??= {};
  tools.features.mythicMagic = { onInit };

  function enabled() {
    return game.settings.get(moduleId, settings.mythicMagicEnabled) !== false;
  }

  function hasFeat(actor) {
    return actor?.itemTypes.feat?.some((feat) => feat.slug === "mythic-magic"
      || feat.sourceId?.endsWith(".d605yhbRoaVgisFG")) ?? false;
  }

  function marked(entry) {
    return entry?.type === "spellcastingEntry" && entry.actor?.type === "character"
      && entry.system.prepared.value === "innate" && entry.flags?.[moduleId]?.[flag] === true;
  }

  function active(entry) {
    return enabled() && marked(entry) && hasFeat(entry.actor);
  }

  function spellRank(actor) {
    return Math.min(10, Math.max(1, Math.ceil(actor.level / 2)));
  }

  function validSpell(spell, actor) {
    return !spell.isCantrip && !spell.isFocusSpell && !spell.isRitual
      && spell.baseRank <= spellRank(actor);
  }

  function mythicAttribute(entry) {
    const selected = entry._source?.system.ability.value;
    if (mentalAttributes.includes(selected)) return selected;
    const caster = entry.actor.itemTypes.spellcastingEntry.find((other) => other !== entry
      && (other.isPrepared || other.isSpontaneous) && mentalAttributes.includes(other.attribute));
    return caster?.attribute ?? "cha";
  }

  function onInit() {
    if (installed || !enabled()) return;
    // PF2e 8 / Foundry 14 are the first supported combination for this feature.
    if (Number(game.release?.generation) < 14 || Number.parseInt(game.system?.version) < 8) return;
    const entryPrototype = CONFIG.PF2E?.Item?.documentClasses?.spellcastingEntry?.prototype;
    const spellPrototype = CONFIG.PF2E?.Item?.documentClasses?.spell?.prototype;
    const traditionDescriptor = Object.getOwnPropertyDescriptor(entryPrototype ?? {}, "tradition");
    if (!["prepareStatistic", "prepareSiblingData", "prepareActorData", "getRollOptions", "getSheetData", "cast"].every(
      (name) => typeof entryPrototype?.[name] === "function",
    ) || !traditionDescriptor?.get || !traditionDescriptor.configurable
      || typeof spellPrototype?.prepareBaseData !== "function" || !game.pf2e?.Modifier) {
      console.warn(`${logPrefix} | Mythic Magic is unavailable in this PF2e version`);
      return;
    }

    // The feat grants no fixed tradition. PF2e uses null for casting entries
    // that leave tradition to the spell; an empty stored value alone means arcane.
    Object.defineProperty(entryPrototype, "tradition", {
      ...traditionDescriptor,
      get() { return active(this) ? null : traditionDescriptor.get.call(this); },
    });
    const getRollOptions = entryPrototype.getRollOptions;
    entryPrototype.getRollOptions = function (prefix = this.type, ...args) {
      const options = getRollOptions.call(this, prefix, ...args);
      return active(this) ? options.filter((option) => option !== `${prefix}:null`
        && option !== `${prefix}:tradition:null`) : options;
    };
    const prepareActor = entryPrototype.prepareActorData;
    entryPrototype.prepareActorData = function (...args) {
      const options = this.actor?.flags?.pf2e?.rollOptions?.all;
      const key = "self:caster:tradition:null";
      const hadOption = options && Object.hasOwn(options, key);
      const result = prepareActor.apply(this, args);
      if (active(this) && options && !hadOption) delete options[key];
      return result;
    };

    const prepareSpell = spellPrototype.prepareBaseData;
    spellPrototype.prepareBaseData = function (...args) {
      const entry = this.actor?.items.get(this.system.location.value);
      if (active(entry) && validSpell(this, this.actor)) {
        // Set derived data before PF2e heightens areas and other spell properties.
        // No document update: leveling down, disabling or removing the feat is reversible.
        this.system.location.heightenedLevel = spellRank(this.actor);
      }
      return prepareSpell.apply(this, args);
    };

    const prepareStatistic = entryPrototype.prepareStatistic;
    entryPrototype.prepareStatistic = function (...args) {
      const isMythic = active(this);
      const attribute = isMythic ? mythicAttribute(this) : null;
      if (isMythic) {
        // Mythic Magic is its own proficiency, never a physical class DC selected
        // in the native dialog. Normalize derived data without rewriting the source.
        this.system.proficiency.slug = "";
        this.system.ability.value = attribute;
      }
      const result = prepareStatistic.apply(this, args);
      if (!isMythic) return result;
      const statistic = this.statistic;
      const data = foundry.utils.deepClone(statistic.data);
      const proficiency = new game.pf2e.Modifier({
        slug: "proficiency",
        label: "Мифическое владение",
        modifier: this.actor.level + 10,
        type: "proficiency",
      });
      // PF2e clamps numeric ranks to 0–4. Supply a real proficiency modifier
      // instead of persisting an unsupported rank 5 or changing every spell entry.
      data.rank = null;
      data.proficient = true;
      data.label = label;
      // Native preparation interpolates the nullable tradition into selectors.
      for (const part of [data.check, data.dc]) {
        if (part?.domains) part.domains = part.domains.filter((domain) => !/^null-spell-(attack|dc)$/.test(domain));
      }
      data.attribute = attribute;
      this.system.ability.value = attribute;
      data.domains = [...(data.domains ?? []).filter((domain) => !/^(str|dex|con|int|wis|cha)-based$/.test(domain)), `${attribute}-based`];
      data.modifiers = [...(data.modifiers ?? []).filter((m) => m.type !== "proficiency"
        && (m.type !== "ability" || m.ability === attribute)), proficiency];
      data.rollOptions = [...(data.rollOptions ?? []).filter((option) =>
        !/^spellcasting:(attribute:)?(str|dex|con|int|wis|cha)$/.test(option)),
      `spellcasting:${attribute}`, `spellcasting:attribute:${attribute}`,
      "proficiency:mythic", "spellcasting:mythic-magic"];
      this.statistic = new statistic.constructor(this.actor, data, statistic.config);
      this.statistic.base = statistic.base;
      // Mythic proficiency applies only to this feat's spells, not the actor's
      // general best spell/class DC, which the native preparation already set.
      return result;
    };

    const prepareSiblings = entryPrototype.prepareSiblingData;
    entryPrototype.prepareSiblingData = function (...args) {
      const result = prepareSiblings.apply(this, args);
      if (!active(this) || !this.spells) return result;
      const collection = this.spells;
      const addSpell = collection.addSpell;
      collection.addSpell = async (spell, options = {}) => {
        if (!active(this)) return addSpell.call(collection, spell, options);
        if (!validSpell(spell, this.actor)) {
          ui.notifications.warn("Для мифической магии добавьте обычное заклинание не выше доступного ранга.");
          return null;
        }
        // Both sheet drops and compendium-browser additions use this collection.
        return addSpell.call(collection, spell, { ...options, groupId: spellRank(this.actor) });
      };
      return result;
    };

    const getSheetData = entryPrototype.getSheetData;
    entryPrototype.getSheetData = async function (...args) {
      const data = await getSheetData.apply(this, args);
      if (!active(this)) return data;
      const rank = spellRank(this.actor);
      const spells = this.spells.contents.slice().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
      data.groups = [{
        id: rank,
        number: rank,
        maxRank: rank,
        label: `${label} — ${rank}-й ранг`,
        active: spells.map((spell) => ({ spell, castRank: rank, expended: false })),
      }];
      // Keep normal spell rows, editing, deletion, drag/drop and chat buttons.
      // Mythic points replace per-spell innate uses; there are no daily slots.
      data.isInnate = false;
      data.showSlotlessRanks = true;
      return data;
    };

    const cast = entryPrototype.cast;
    entryPrototype.cast = async function (spell, options = {}) {
      if (!enabled() || !marked(this)) return cast.call(this, spell, options);
      if (!hasFeat(this.actor)) {
        ui.notifications.warn("Для мифической магии нужна черта Mythic Magic.");
        return;
      }
      if (spell.system.location.value !== this.id || !validSpell(spell, this.actor)) {
        ui.notifications.warn("Это заклинание нельзя сотворить через мифическую магию.");
        return;
      }
      const rank = spellRank(this.actor);
      if (options.consume === false) return cast.call(this, spell, { ...options, rank, consume: false });
      const actor = this.actor;
      if (castingActors.has(actor)) return;
      castingActors.add(actor);
      try {
        const points = actor.system.resources.mythicPoints?.value ?? 0;
        if (points < 1) {
          ui.notifications.warn("Недостаточно мифических пунктов.");
          return;
        }
        await actor.update({ "system.resources.mythicPoints.value": points - 1 });
        return await cast.call(this, spell, { ...options, rank, consume: false });
      } finally {
        castingActors.delete(actor);
      }
    };

    Hooks.on("renderActorSheet", onRenderSheet);
    Hooks.on("renderSpellcastingCreateAndEditDialog", onRenderSpellcastingDialog);
    installed = true;
  }

  function onRenderSpellcastingDialog(app, html) {
    const entry = app.object;
    const root = html?.querySelector ? html : html?.[0];
    if (!active(entry) || !root) return;
    const tradition = root.querySelector('select[name="system.tradition.value"]');
    if (tradition) {
      tradition.disabled = true;
      tradition.closest(".form-group")?.remove();
    }
    const proficiency = root.querySelector('select[name="system.proficiency.slug"]');
    if (proficiency) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Мифическое";
      proficiency.replaceChildren(option);
      proficiency.value = "";
      // Keep it in the submitted form so saving clears a previously selected class DC.
      proficiency.disabled = false;
    }
    const ability = root.querySelector('select[name="system.ability.value"]');
    if (ability) {
      for (const option of Array.from(ability.options)) {
        if (!mentalAttributes.includes(option.value)) option.remove();
      }
      ability.value = mythicAttribute(entry);
      ability.disabled = false;
    }
  }

  function onRenderSheet(app, html) {
    const actor = app.actor;
    const root = html?.querySelector ? html : html?.[0];
    if (!enabled() || actor?.type !== "character" || !root) return;
    const editable = actor.isOwner && app.isEditable !== false;
    const feat = hasFeat(actor);
    for (const element of root.querySelectorAll(".spellcasting-entry[data-item-id]")) {
      const entry = actor.items.get(element.dataset.itemId);
      if (!entry || entry.system.prepared.value !== "innate") continue;
      const isActive = active(entry);
      if (isActive) {
        const proficiency = element.querySelector(".spellcasting-prof .pf-rank");
        if (proficiency) {
          proficiency.textContent = "Мифическое";
          proficiency.dataset.rank = "mythic";
          proficiency.style.width = "auto";
          proficiency.style.maxWidth = "none";
          proficiency.title = `Мифическое владение: уровень ${actor.level} + 10`;
        }
        element.querySelector('[data-action="toggle-show-slotless-ranks"]')?.remove();
        // Selection limits from the feat are checked by the player/GM. The browser
        // shows base ranks, whereas the single displayed group shows the cast rank.
        for (const browser of element.querySelectorAll('[data-action="browse-spells"]')) {
          browser.dataset.rank = String(actor.level >= 20 ? 4 : actor.level >= 14 ? 3 : 2);
        }
        // A newly created blank spell uses the displayed rank as its base rank.
        // Prefer selecting an existing spell, as required by the feat.
        element.querySelector('[data-action="create-item"][data-type="spell"]')?.remove();
        const header = element.querySelector(".spell-ability-data");
        if (header && !header.querySelector(".eliott-mythic-points")) {
          const points = document.createElement("span");
          points.className = "eliott-mythic-points";
          points.textContent = `Мифические пункты: ${actor.system.resources.mythicPoints?.value ?? 0}`;
          points.title = "Сотворение заклинания расходует 1 мифический пункт";
          header.append(points);
        }
      }
      const controls = element.querySelector(".action-header .item-controls");
      if (editable && controls && (feat || marked(entry)) && !controls.querySelector(".eliott-mythic-toggle")) {
        const toggle = document.createElement("a");
        toggle.className = "eliott-mythic-toggle";
        toggle.role = "button";
        toggle.tabIndex = 0;
        toggle.title = marked(entry) ? "Отключить мифическую магию" : "Использовать для черты «Мифическая магия»";
        toggle.setAttribute("aria-label", toggle.title);
        toggle.setAttribute("aria-pressed", String(marked(entry)));
        const icon = document.createElement("i");
        icon.className = `fa-${marked(entry) ? "solid" : "regular"} fa-star`;
        toggle.append(icon);
        const changeMode = (event) => {
          event.preventDefault();
          event.stopPropagation();
          void entry.update({ [flagPath]: !marked(entry) }).catch(reportError);
        };
        toggle.addEventListener("click", changeMode);
        toggle.addEventListener("keydown", (event) => {
          if (["Enter", " "].includes(event.key)) changeMode(event);
        });
        controls.prepend(toggle);
      }
    }

    const create = root.querySelector('[data-action="spellcasting-create"]');
    if (editable && feat && create && !actor.itemTypes.spellcastingEntry.some(marked)
      && !root.querySelector(".eliott-mythic-create")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "blue eliott-mythic-create";
      button.textContent = "+ Мифическая магия";
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        try {
          if (!hasFeat(actor) || actor.itemTypes.spellcastingEntry.some(marked)) return;
          const casting = actor.itemTypes.spellcastingEntry.find((entry) => (entry.isPrepared || entry.isSpontaneous)
            && mentalAttributes.includes(entry.attribute));
          await actor.createEmbeddedDocuments("Item", [{
            name: label,
            type: "spellcastingEntry",
            system: {
              prepared: { value: "innate" },
              tradition: { value: "" },
              ability: { value: casting?.attribute ?? "cha" },
            },
            flags: { [moduleId]: { [flag]: true } },
          }]);
        } catch (error) {
          reportError(error);
        } finally {
          button.disabled = false;
        }
      });
      create.after(button);
    }
  }

  function reportError(error) {
    console.error(`${logPrefix} | Mythic Magic`, error);
    ui.notifications.error("Не удалось изменить мифическую магию. Подробности — в консоли Foundry.");
  }
})();
