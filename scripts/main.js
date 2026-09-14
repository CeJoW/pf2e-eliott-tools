(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const oathOfTheDefender = tools.features.champion.oathOfTheDefender;
  const shieldsOfTheSpirit = tools.features.spells.shieldsOfTheSpirit;
  const criticalDeckTranslation = tools.features.criticalDeckTranslation;
  const combatTrackerEnhancements = tools.features.combatTrackerEnhancements;
  const worldClock = tools.features.worldClock;
  const preciousMaterialArmor = tools.features.preciousMaterialArmor;
  const weaponFamiliarity = tools.features.weaponFamiliarity;

  Hooks.once("init", () => {
    registerSettings();
    weaponFamiliarity.onInit();
    tools.features.energyResistantRunes?.onInit();
    tools.features.mythicMagic?.onInit();
    tools.features.weaponRuneCompatibility?.onInit();
    worldClock.onInit();

    if (isSettingEnabled(settings.oathOfTheDefenderEnabled)) {
      oathOfTheDefender.onInit();
    }

    criticalDeckTranslation.onInit();

    console.log(`${logPrefix} | init`);
  });

  Hooks.once("ready", () => {
    criticalDeckTranslation.onReady();
    worldClock.onReady();
    void initializeFrightenedRecovery();
    void initializeBestiary();
    void initializeRegaliaIntensify();
    void initializeEnergyResistantRunes();

    console.log(`${logPrefix} | ready`);
  });

  Hooks.on("updateCombat", (...args) => {
    combatTrackerEnhancements.onUpdateCombat(...args);
  });

  Hooks.on("deleteCombat", (...args) => {
    combatTrackerEnhancements.onDeleteCombat(...args);
  });

  Hooks.on("renderCombatTracker", (...args) => {
    combatTrackerEnhancements.onRenderCombatTracker(...args);
  });

  Hooks.on("renderSettingsConfig", (...args) => {
    onRenderSettingsConfig(...args);
  });

  Hooks.on("createChatMessage", (...args) => {
    if (isSettingEnabled(settings.preciousMaterialArmorEnabled)) {
      void preciousMaterialArmor.onCreateChatMessage(...args);
    }

    if (isSettingEnabled(settings.oathOfTheDefenderEnabled)) {
      void oathOfTheDefender.onCreateChatMessage(...args);
    }

    if (isSettingEnabled(settings.shieldsOfTheSpiritEnabled)) {
      void shieldsOfTheSpirit.onCreateChatMessage(...args);
    }
  });

  Hooks.on("renderChatMessage", (...args) => {
    if (isSettingEnabled(settings.oathOfTheDefenderEnabled)) {
      return oathOfTheDefender.onRenderChatMessage(...args);
    }
  });

  async function initializeEnergyResistantRunes() {
    if (tools.features.energyResistantRunes) return;
    try {
      // Support a browser reload while the server still caches the old manifest.
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = foundry.utils.getRoute(`modules/${moduleId}/scripts/features/energy-resistant-runes.js`);
        script.onload = resolve;
        script.onerror = () => reject(new Error("Could not load energy-resistant-runes.js"));
        document.head.append(script);
      });
      tools.features.energyResistantRunes.onInit();
      const actors = new Set([
        ...game.actors.contents,
        ...(canvas.tokens?.placeables ?? []).map((token) => token.actor).filter(Boolean),
      ]);
      for (const actor of actors) actor.reset();
    } catch (error) {
      console.error(`${logPrefix} | Could not initialize Energy-Resistant runes`, error);
      ui.notifications.error("Не удалось загрузить автоматизацию рун сопротивления энергии. Перезагрузите страницу Foundry.");
    }
  }

  async function initializeRegaliaIntensify() {
    try {
      if (!tools.features.regaliaIntensify) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = foundry.utils.getRoute(`modules/${moduleId}/scripts/features/regalia-intensify.js`);
          script.onload = resolve;
          script.onerror = () => reject(new Error("Could not load regalia-intensify.js"));
          document.head.append(script);
        });
      }
      tools.features.regaliaIntensify.initialize();
    } catch (error) {
      console.error(`${logPrefix} | Could not initialize regalia`, error);
      ui.notifications.error("Не удалось загрузить регалию. Обновите страницу Foundry.");
    }
  }

  async function initializeBestiary() {
    try {
      if (!tools.features.bestiary?.initialize) {
        for (const file of ["model", "store", "application", "index"]) {
          await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = foundry.utils.getRoute(`modules/${moduleId}/scripts/features/bestiary/${file}.js`);
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Could not load bestiary/${file}.js`));
            document.head.append(script);
          });
        }
      }
      const href = foundry.utils.getRoute(`modules/${moduleId}/styles/bestiary.css`);
      if (!document.querySelector(`link[href="${href}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        document.head.append(link);
      }
      tools.features.bestiary.initialize();
      // Directory rendering may precede this fallback loader on a cached manifest.
      ui.actors?.render();
      ui.journal?.render();
    } catch (error) {
      console.error(`${logPrefix} | Could not initialize bestiary`, error);
      ui.notifications.error("Не удалось загрузить бестиарий. Перезагрузите страницу Foundry.");
    }
  }

  async function initializeFrightenedRecovery() {
    try {
      // Foundry caches the manifest's script list on the server. A browser reload
      // can load a new main.js without loading a newly added manifest entry.
      if (!tools.features.frightenedRecovery) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = foundry.utils.getRoute(`modules/${moduleId}/scripts/features/frightened-recovery.js`);
          script.onload = resolve;
          script.onerror = () => reject(new Error("Could not load frightened-recovery.js"));
          document.head.append(script);
        });
      }
      const feature = tools.features.frightenedRecovery;
      if (typeof feature?.onEndTurn !== "function" || typeof feature?.onUpdateCombat !== "function") {
        throw new Error("Frightened recovery handlers are unavailable");
      }
      Hooks.on("updateCombat", (...args) => feature.onUpdateCombat(...args));
      Hooks.on("pf2e.endTurn", (...args) => { void feature.onEndTurn(...args); });
    } catch (error) {
      console.error(`${logPrefix} | Could not initialize frightened recovery`, error);
      ui.notifications.error("Не удалось загрузить автоматизацию испуга. Перезагрузите страницу Foundry.");
    }
  }

  function registerSettings() {
    game.settings.register(moduleId, settings.weaponRuneCompatibilityEnabled, {
      name: "Защита листа от неизвестных рун оружия",
      hint: "Если PF2e не узнаёт руну импортированного оружия, сохраняет её в предмете, временно исключает из расчёта атаки и предупреждает владельца. Остальные атаки и заклинания продолжают рассчитываться.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      requiresReload: true,
    });
    game.settings.register(moduleId, settings.mythicMagicEnabled, {
      name: "Мифическая магия в листе персонажа",
      hint: "Добавляет режим для черты Mythic Magic: один автоматически повышаемый ранг заклинаний, мифическое владение и расход мифических пунктов. Требуются Foundry 14 и PF2e 8. После изменения перезагрузите страницу.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      requiresReload: true,
    });
    game.keybindings.register(moduleId, "bestiary", {
      name: "Открыть бестиарий группы",
      hint: "Открывает журнал встреченных существ. Игроки и мастер могут назначить своё сочетание клавиш; по умолчанию Shift+B.",
      editable: [{ key: "KeyB", modifiers: ["Shift"] }],
      restricted: false,
      onDown: () => { tools.bestiary?.open(); return true; },
    });
    game.settings.registerMenu(moduleId, "bestiaryKeybindings", {
      name: "Клавиши бестиария",
      label: "Настроить клавиши",
      hint: "В редакторе управления выберите PF2E Eliott Tools → «Открыть бестиарий группы». Сочетание настраивается лично каждым игроком и мастером в своём браузере.",
      icon: "fas fa-keyboard",
      type: foundry.applications?.sidebar?.apps?.ControlsConfig
        ?? foundry.applications?.settings?.KeybindingsConfig
        ?? globalThis.KeybindingsConfig,
      restricted: false,
    });

    game.settings.register(moduleId, settings.weaponFamiliarityEnabled, {
      name: "Включить фикс Weapon Familiarity",
      hint: "Знакомство с оружием родословной учитывает повышенное владение конкретной группой оружия: например, орочий продвинутый топор получает мастера воинских топоров. После изменения требуется перезагрузка мира в браузере.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      requiresReload: true,
    });

    game.settings.register(moduleId, settings.energyResistantRunesEnabled, {
      name: "Автоматизировать руны сопротивления энергии",
      hint: "Руны Energy-Resistant на надетом и инвестированном доспехе дают сопротивление 5, усиленные — 10: кислота, холод, электричество или огонь. После изменения требуется перезагрузка мира в браузере.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      requiresReload: true,
    });

    game.settings.register(moduleId, settings.preciousMaterialArmorEnabled, {
      name: "Включить эффекты материалов доспеха при критическом промахе",
      hint: "Критический промах безоружной атакой по надетому доспеху из холодного железа, серебра или суверенной стали накладывает тошноту 1 на атакующего с соответствующей уязвимостью. Учитывает иммунитет к тошноте.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });

    game.settings.register(moduleId, settings.frightenedRecoveryEnabled, {
      name: "Автоматически уменьшать испуг в конце хода",
      hint: "Уменьшает испуг (Frightened) на 1 в конце собственного хода персонажа или NPC; при 0 снимает состояние. Не изменяет состояния, закреплённые эффектами. Текстовые исключения вроде Remorseless Lash требуют ручного контроля. Не включайте одновременно с другой автоматизацией уменьшения испуга.",
      scope: "world",
      config: true,
      type: Boolean,
      default: false,
    });

    game.settings.register(moduleId, settings.clearTargetsOnTurnEndEnabled, {
      name: "Сбрасывать цели в конце хода",
      hint: "Автоматически снимает все ваши цели при смене хода или раунда в боевом трекере. Настройка индивидуальна для каждого игрока.",
      scope: "client",
      config: true,
      type: Boolean,
      default: true,
    });

    game.settings.register(moduleId, settings.combatTrackerHpRingEnabled, {
      name: "Показывать HP-кольцо в трекере",
      hint: "Добавляет круговой индикатор здоровья вокруг портрета участника боя, учитывая видимость HP-бара токена.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });

    game.settings.register(moduleId, settings.oathOfTheDefenderEnabled, {
      name: "Включить фикс Oath of the Defender",
      hint: "Исправляет ауру чемпиона Oath of the Defender: сопротивление применяется только к самому большому подходящему инстансу урона.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });

    game.settings.register(moduleId, settings.shieldsOfTheSpiritEnabled, {
      name: "Включить автоматизацию Shields of the Spirit",
      hint: "Автоматически бросает spirit-урон по атакующему, когда он делает действие с признаком attack против цели с эффектом Shields of the Spirit.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });

    game.settings.register(moduleId, settings.criticalDeckTranslationEnabled, {
      name: "Включить русский оверрайд крит-колоды",
      hint: "Перенаправляет броски PF2e Critical Hit/Fumble Deck на русские записи журнала из этого модуля.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });
  }

  function getSettingsGroups() {
    return [
      {
        title: "Автоматизация листа персонажа",
        settings: [
          {
            key: settings.weaponRuneCompatibilityEnabled,
            name: "Защита от неизвестных рун оружия",
            scope: "world",
          },
          {
            key: settings.weaponFamiliarityEnabled,
            name: "Фикс Weapon Familiarity",
            scope: "world",
          },
          {
            key: settings.preciousMaterialArmorEnabled,
            name: "Эффекты материалов при критическом промахе",
            scope: "world",
          },
          {
            key: settings.energyResistantRunesEnabled,
            name: "Руны сопротивления энергии",
            scope: "world",
          },
          {
            key: settings.frightenedRecoveryEnabled,
            name: "Уменьшение испуга в конце хода",
            scope: "world",
          },
        ],
      },
      {
        title: "Время мира",
        settings: [
          {
            key: settings.worldClockEnabled,
            name: "Включить автоматический ход времени",
            scope: "world",
          },
        ],
      },
      {
        title: "Бой",
        settings: [
          {
            key: settings.clearTargetsOnTurnEndEnabled,
            name: "Сбрасывать цели в конце хода",
            hint: "Автоматически снимает все ваши цели при смене хода или раунда в боевом трекере.",
            scope: "client",
          },
          {
            key: settings.combatTrackerHpRingEnabled,
            name: "Показывать HP-кольцо в трекере",
            hint: "Добавляет круговой индикатор здоровья вокруг портрета участника боя, учитывая видимость HP-бара токена.",
            scope: "world",
          },
        ],
      },
      {
        title: "Автоматизация заклинаний",
        settings: [
          {
            key: settings.mythicMagicEnabled,
            name: "Мифическая магия",
            scope: "world",
          },
          {
            key: settings.oathOfTheDefenderEnabled,
            name: "Фикс Oath of the Defender",
            hint: "Исправляет ауру чемпиона Oath of the Defender: сопротивление применяется только к самому большому подходящему инстансу урона.",
            scope: "world",
          },
          {
            key: settings.shieldsOfTheSpiritEnabled,
            name: "Shields of the Spirit",
            hint: "Автоматически бросает spirit-урон по атакующему, когда он делает действие с признаком attack против цели с эффектом Shields of the Spirit.",
            scope: "world",
          },
        ],
      },
      {
        title: "Перевод и колоды",
        settings: [
          {
            key: settings.criticalDeckTranslationEnabled,
            name: "Русский оверрайд крит-колоды",
            hint: "Перенаправляет броски PF2e Critical Hit/Fumble Deck на русские записи журнала из этого модуля.",
            scope: "world",
          },
        ],
      },
    ];
  }

  function isSettingEnabled(key) {
    return game.settings.get(moduleId, key) !== false;
  }

  function onRenderSettingsConfig(_app, html) {
    const root = getHtmlElement(html);
    if (!root) return;

    root.querySelectorAll(".pf2e-eliott-settings-heading").forEach((heading) => heading.remove());
    hideSettingRowForPlayers(root, settings.combatTrackerHpRingEnabled);
    hideSettingRowForPlayers(root, settings.worldClockEnabled);
    hideSettingRowForPlayers(root, settings.preciousMaterialArmorEnabled);
    hideSettingRowForPlayers(root, settings.weaponFamiliarityEnabled);
    hideSettingRowForPlayers(root, settings.energyResistantRunesEnabled);
    hideSettingRowForPlayers(root, settings.frightenedRecoveryEnabled);

    for (const group of getSettingsGroups()) {
      const firstRow = findSettingRow(root, group.settings[0]?.key);
      if (!firstRow) continue;

      const heading = document.createElement("h2");
      heading.className = "pf2e-eliott-settings-heading";
      heading.textContent = group.title;
      firstRow.before(heading);
    }
  }

  function findSettingRow(root, key) {
    if (!key) return null;

    const input = root.querySelector(`[name="${moduleId}.${key}"], [name="${key}"]`);
    return input?.closest(".form-group")
      ?? input?.closest("fieldset")
      ?? input?.parentElement
      ?? null;
  }

  function hideSettingRowForPlayers(root, key) {
    if (game.user.isGM) return;

    findSettingRow(root, key)?.remove();
  }

  function getHtmlElement(html) {
    if (html instanceof HTMLElement) return html;
    if (html?.[0] instanceof HTMLElement) return html[0];
    if (html?.element instanceof HTMLElement) return html.element;
    return null;
  }
})();
