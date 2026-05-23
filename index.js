require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  ActivityType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  PermissionsBitField,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
} = require("discord.js");

const app = express();

app.get("/", (req, res) => {
  res.send("Bot dziala");
});

app.listen(3000, () => {
  console.log("Serwer HTTP dziala");
});

const VERIFIED_ROLE_ID = "1418192133772542024";
const VERIFIED_ROLE_ID_2 = "1506295564281712700";
const WELCOME_CHANNEL_ID = "1418191470933839932";
const PARTNER_CHANNEL_ID = "1418190560723996713";
const PARTNER_REWARD_GROSZE = 50;
const PARTNER_LINK_TIME = 2 * 24 * 60 * 60 * 1000;
const PARTNER_DATA_FILE = path.join(__dirname, "partnerstwa.json");


const ticketNames = {
  zakup: "zakup",
  skup: "skup",
  index: "index",
  middleman: "middleman",
  pomoc: "pomoc",
};

const konkursy = new Map();
const tworzoneTickety = new Set();
const dropCooldowns = new Map();
const inviteCache = new Map();
const DROP_COOLDOWN = 4 * 60 * 60 * 1000;


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
  ],
});

function loadPartnerData() {
  if (!fs.existsSync(PARTNER_DATA_FILE)) {
    return { wallets: {}, links: {} };
  }

  try {
    return JSON.parse(fs.readFileSync(PARTNER_DATA_FILE, "utf8"));
  } catch (err) {
    console.error("Nie można odczytac danych partnerstw:", err);
    return { wallets: {}, links: {} };
  }
}

const partnerData = loadPartnerData();

function savePartnerData() {
  fs.writeFileSync(PARTNER_DATA_FILE, JSON.stringify(partnerData, null, 2));
}

function formatMoney(grosze) {
  return `${(grosze / 100).toFixed(2).replace(".", ",")} zł`;
}

function getInviteCodes(content) {
  return Array.from(
    content.matchAll(/(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([a-zA-Z0-9-]+)/gi),
    (match) => match[1]
  );
}

function getPartnerUrls(content) {
  return Array.from(
    content.matchAll(/(?:https?:\/\/|www\.|discord\.gg\/|discord(?:app)?\.com\/invite\/)[^\s<>()]+/gi),
    (match) => {
      const url = match[0].replace(/[.,!?;:]+$/, "");
      return url.startsWith("http") ? url : `https://${url}`;
    }
  );
}

function createPartnerKey(url) {
  const inviteCode = getInviteCodes(url)[0];
  if (inviteCode) return `invite:${inviteCode.toLowerCase()}`;

  return `url:${url.toLowerCase().replace(/\/+$/, "")}`;
}

function isActivePartnerLink(link) {
  return link && Date.now() <= link.expiresAt;
}

async function cacheGuildInvites(guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return;

  inviteCache.set(
    guild.id,
    new Map(invites.map((invite) => [invite.code, invite.uses || 0]))
  );
}

async function findUsedInvite(guild) {
  const oldInvites = inviteCache.get(guild.id) || new Map();
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;

  const usedInvite = invites.find((invite) => (invite.uses || 0) > (oldInvites.get(invite.code) || 0));

  inviteCache.set(
    guild.id,
    new Map(invites.map((invite) => [invite.code, invite.uses || 0]))
  );

  return usedInvite || null;
}

async function registerPartnerLinks(message) {
  if (message.channel.id !== PARTNER_CHANNEL_ID) return;

  const urls = getPartnerUrls(message.content);
  if (urls.length === 0) return;

  let saved = 0;
  let duplicate = false;

  for (const url of urls) {
    const key = createPartnerKey(url);

    if (isActivePartnerLink(partnerData.links[key])) {
      duplicate = true;
      continue;
    }

    const inviteCode = getInviteCodes(url)[0];
    const invite = inviteCode ? await client.fetchInvite(inviteCode).catch(() => null) : null;

    partnerData.links[key] = {
      ownerId: message.author.id,
      channelId: message.channel.id,
      messageId: message.id,
      url,
      guildId: invite?.guild?.id || null,
      guildName: invite?.guild?.name || "Link partnerstwa",
      createdAt: Date.now(),
      expiresAt: Date.now() + PARTNER_LINK_TIME,
    };
    saved++;
  }

  if (duplicate && saved === 0) {
    await message.delete().catch(() => null);
    return;
  }

  if (saved === 0) return;

  savePartnerData();
  return message.react("\u2705").catch(() => null);
}
function cleanName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 20);
}

function isTicketChannel(channel) {
  return channel?.type === ChannelType.GuildText && channel.name.startsWith("ticket-");
}

function canSendInChannel(guild, channel) {
  return channel?.type === ChannelType.GuildText &&
    channel.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages);
}

function findWelcomeChannel(guild) {
  const welcomeChannel = guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (canSendInChannel(guild, welcomeChannel)) {
    return welcomeChannel;
  }

  if (canSendInChannel(guild, guild.systemChannel)) {
    return guild.systemChannel;
  }

  return guild.channels.cache.find((channel) => canSendInChannel(guild, channel));
}

function createModerationEmbed(title, fields, guild) {
  return new EmbedBuilder()
    .setColor("#00ffff")
    .setTitle(title)
    .addFields(fields)
    .setFooter({
      text: "AQYA SHOP × MODERACJA",
      iconURL: guild.iconURL({ dynamic: true }),
    });
}

async function zakonczKonkurs(konkursId) {
  const konkurs = konkursy.get(konkursId);
  if (!konkurs) return;

  konkursy.delete(konkursId);

  const channel = await client.channels.fetch(konkurs.channelId).catch(() => null);
  if (!channel) return;

  const message = await channel.messages.fetch(konkurs.messageId).catch(() => null);

  const disabledButton = new ButtonBuilder()
    .setCustomId(`konkurs_join_${konkursId}`)
    .setLabel("Konkurs zakończony")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  const disabledRow = new ActionRowBuilder().addComponents(disabledButton);

  if (message) {
    await message.edit({ components: [disabledRow] }).catch(() => null);
  }

  if (konkurs.uczestnicy.size === 0) {
    return channel.send(
      ` Konkurs **${konkurs.nagroda}** zakończony. Nikt nie wziął udziału.`
    );
  }

  const uczestnicy = Array.from(konkurs.uczestnicy);
  const zwyciezcaId = uczestnicy[Math.floor(Math.random() * uczestnicy.length)];

  return channel.send(
    ` Konkurs **${konkurs.nagroda}** zakończony!\n?? Zwyciezca: <@${zwyciezcaId}>`
  );
}

async function createTicket(interaction, choice, answers = null) {
  if (!interaction.guild) return;

  const categoryName = ticketNames[choice] || "ticket";
  const lockKey = `${interaction.guild.id}:${interaction.user.id}`;

  if (tworzoneTickety.has(lockKey)) {
    return interaction.reply({
      content: "? Ticket jest już tworzony, poczekaj chwile.",
      ephemeral: true,
    });
  }

  tworzoneTickety.add(lockKey);

  try {
    const existing = interaction.guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        c.topic?.includes(`User: ${interaction.user.id}`) &&
        c.name.startsWith(`ticket-${categoryName}-`)
    );

    if (existing) {
      return interaction.reply({
        content: "? Masz już otwarty ticket!",
        ephemeral: true,
      });
    }

    const userName = cleanName(interaction.user.username);

    const channel = await interaction.guild.channels.create({
      name: `ticket-${categoryName}-${userName}`,
      type: ChannelType.GuildText,
      topic: `Ticket: ${choice} | User: ${interaction.user.id}`,
      permissionOverwrites: [
        {
          id: interaction.guild.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: interaction.client.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageChannels,
          ],
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
      ],
    });

    const closeButton = new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Zamknij ticket")
      .setStyle(ButtonStyle.Danger);

    const closeRow = new ActionRowBuilder().addComponents(closeButton);

    let description = ` Autor: ${interaction.user}
 Kategoria: **${choice}**

Opisz dokładnie swoją sprawę, a administracją niedługo odpowie.`;

    if (answers) {
      description = ` Autor: ${interaction.user}
 Kategoria: **${choice}**

 Co chcę kupić:
**${answers.item}**

 Budżet:
**${answers.budget}**

 Metoda płatności:
**${answers.payment}**`;
    }

    const ticketEmbed = new EmbedBuilder()
      .setColor("#00ffff")
      .setTitle("Ticket utworzony")
      .setDescription(description)
      .setFooter({
        text: "AQYA SHOP × TICKETY",
        iconURL: interaction.guild.iconURL({ dynamic: true }),
      });

    await channel.send({
      embeds: [ticketEmbed],
      components: [closeRow],
    });

    const replyPayload = {
      content: ` Ticket utworzony: ${channel}`,
      ephemeral: true,
    };

    if (interaction.replied || interaction.deferred) {
      return interaction.followUp(replyPayload);
    }

    return interaction.reply(replyPayload);
  } catch (err) {
    console.error("Błąd przy tworzeniu ticketa:", err);

    const errorPayload = {
      content: "? Wystąpił błąd przy tworzeniu ticketa. Sprawdź uprawnieńia bota do tworzenia kanał?w i wysyłania wiadomości.",
      ephemeral: true,
    };

    if (interaction.replied || interaction.deferred) {
      return interaction.followUp(errorPayload).catch(() => null);
    }

    return interaction.reply(errorPayload).catch(() => null);
  } finally {
    tworzoneTickety.delete(lockKey);
  }
}
client.once("ready", async () => {
  console.log(`Zalogowano jako ${client.user.tag}`);

  client.user.setPresence({
    activities: [
      {
        name: "AQYA SHOP",
        type: ActivityType.Watching,
      },
    ],
    status: "online",
  });

  await client.application.commands.set([]);
  console.log("Globalne komendy zostały wyczyszczone");

  const commands = [
    new SlashCommandBuilder()
      .setName("tickets")
      .setDescription("Wysyła panel ticketów"),
    new SlashCommandBuilder()
      .setName("cennik")
      .setDescription("Wysyła panel cennika"),
    new SlashCommandBuilder()
      .setName("weryfikacja")
      .setDescription("Wysyła panel weryfikacji"),
    new SlashCommandBuilder()
      .setName("drop")
      .setDescription("Losuje drop"),
    new SlashCommandBuilder()
      .setName("close")
      .setDescription("Zamyka aktualny ticket"),
    new SlashCommandBuilder()
      .setName("claim")
      .setDescription("Przejmuje aktualny ticket"),
    new SlashCommandBuilder()
      .setName("partnerstwa")
      .setDescription("Ustawia kanał partnerstw")
      .addChannelOption((option) =>
        option
          .setName("kanal")
          .setDescription("Kanał, na którym bot ma zapisywać linki partnerstw")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("portfel")
      .setDescription("Pokazuje portfel z partnerstw")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("Użytkownik, którego portfel chcesz sprawdzić")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("zatwierdzpartnerstwo")
      .setDescription("Zatwierdza partnerstwo i dodaje 0,50 zł do portfela")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("Użytkownik, któremu dodać nagrodę")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("reset")
      .setDescription("Resetuje portfele i aktywne partnerstwa"),
    new SlashCommandBuilder()
      .setName("mute")
      .setDescription("Wycisza użytkownika")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("Użytkownik do wyciszenia")
          .setRequired(true)
      )
      .addIntegerOption((option) =>
        option
          .setName("minuty")
          .setDescription("Czas wyciszenia w minutach")
          .setMinValue(1)
          .setMaxValue(40320)
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName("powod")
          .setDescription("Powód wyciszenia")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("kick")
      .setDescription("Wyrzuca użytkownika z serwera")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("Użytkownik do wyrzucenia")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("powod")
          .setDescription("Powód wyrzucenia")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("Banuje użytkownika")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("Użytkownik do zbanowania")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("powod")
          .setDescription("Powód bana")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("konkurs")
      .setDescription("Tworzy konkurs")
      .addStringOption((option) =>
        option
          .setName("nagroda")
          .setDescription("Nagroda w konkursie")
          .setRequired(true)
      )
      .addIntegerOption((option) =>
        option
          .setName("czas")
          .setDescription("Czas konkursu w minutach")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("opis")
          .setDescription("Opis konkursu")
          .setRequired(false)
      ),
  ];
  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set(commands);
    await cacheGuildInvites(guild);
  }

  console.log("Komendy zostały zarejestrowane na wszystkich serwerach");
});

client.on("guildMemberAdd", async (member) => {
  const usedInvite = await findUsedInvite(member.guild);
  const usedInviteKey = usedInvite ? `invite:${usedInvite.code.toLowerCase()}` : null;
  const partnerLink = usedInviteKey ? partnerData.links[usedInviteKey] : null;

  if (partnerLink) {
    if (Date.now() <= partnerLink.expiresAt) {
      partnerData.wallets[partnerLink.ownerId] =
        (partnerData.wallets[partnerLink.ownerId] || 0) + PARTNER_REWARD_GROSZE;
      delete partnerData.links[usedInviteKey];
      savePartnerData();
    } else {
      delete partnerData.links[usedInviteKey];
      savePartnerData();
    }
  }

  const channel = findWelcomeChannel(member.guild);
  if (!channel) return;

  const welcomeEmbed = new EmbedBuilder()
    .setColor("#00ffff")
    .setTitle(" AQYA SHOP × POWITANIE")
    .addFields(
      { name: "Użytkownik", value: `${member}`, inline: true },
      { name: "Osoba numer", value: `${member.guild.memberCount}`, inline: true },
      { name: "Wiadomosc", value: "Mamy nadzieje, ze przyniosles pizze!", inline: false }
    )
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setFooter({
      text: "Milo Cie widziec na serwerze",
      iconURL: member.guild.iconURL({ dynamic: true }),
    });

  return channel.send({
    content: `Czesc ${member}!`,
    embeds: [welcomeEmbed],
  });
});


client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  await registerPartnerLinks(message);

  if (message.content === "!regulamin") {
    return message.channel.send(` REGULAMIN SERWERA
?1 Postanowienia og?lne

1.1 Dolaczajac do serwera, akceptujesz niniejszy regulamin.
1.2 Regulamin obowiązuje wszystkich użytkownik?w bez wyjątku.
1.3 Administracja zastrzega sobie prawo do zmiany regulaminu w dowolnym momencie.
1.4 Nieznajomosc regulaminu nie zwalnia z obowiazku jego przestrzegania.
1.5 Serwer dziala zgodnie z zasadami platformy Discord.

?2 Zasady og?lne zachowania

2.1 Szanuj innych użytkownik?w.
2.2 Zakaz dyskryminacji.
2.3 Zakaz tresci NSFW.
2.4 Zakaz spamowania.
2.5 Zakaz reklamowania bez zgody administracji.

?3 Kanały i porzłdek

3.1 Korzystaj z kanał?w zgodnie z ich przeznaczeniem.
3.2 Nie r?b offtopu.
3.3 Nie uzywaj @everyone i @here.

?4 Administracja

4.1 Decyzje administracji sa ostateczne.
4.2 Pr?by omijania kar skutkuja banem.

?5 Kary

- Ostrzezenie
- Wyciszenie
- Tymczasowy ban
- Staly ban

?6 System kar

6.1 W zaleznosci od przewinienia moga zostac zastosowane:
-Ostrzezenie
-Wyciszenie (mute)
-Tymczasowy ban
-Staly ban

?7 Postanowienia końcowe

Regulamin wchodzi w zycie z dniem publikacji.
Przebywanie na serwerze oznacza pelna akceptacje zasad.

?8 Odwołania

8.1 Użytkownik ma prawo odwołać się od kary poprzez kontakt z administracją.
8.2 Administracja rozpatruje odwolania w ciagu maksymalnie 7 dni.
8.3 Decyzja administracji jest ostateczna. 
`);
  }

 
})

     client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const commandName = interaction.commandName;

      if (commandName === "close") {
        if (!isTicketChannel(interaction.channel)) {
          return interaction.reply({
            content: " Tej komendy możesz użyć tylko na tickecie.",
            ephemeral: true,
          });
        }

        await interaction.reply({
          content: " Ticket zostanie zamknięty za 3 sekundy...",
        });

        setTimeout(() => {
          interaction.channel.delete().catch(console.error);
        }, 3000);

        return;
      }

      if (commandName === "claim") {
        if (!isTicketChannel(interaction.channel)) {
          return interaction.reply({
            content: " Tej komendy możesz użyć tylko na tickecie.",
            ephemeral: true,
          });
        }

        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
          return interaction.reply({
            content: "? Nie masz uprawnień do claimowania ticketów.",
            ephemeral: true,
          });
        }

        if (interaction.channel.topic?.includes("Claimed by:")) {
          return interaction.reply({
            content: "? Ten ticket jest już przejęty.",
            ephemeral: true,
          });
        }

        await interaction.channel.setTopic(
          `${interaction.channel.topic || ""} | Claimed by: ${interaction.user.id}`
        );

        const embed = new EmbedBuilder()
          .setColor("#00ffff")
          .setTitle(" Ticket przejęty")
          .setDescription(`Ten ticket zostal przejęty przez ${interaction.user}.`)
          .setFooter({
            text: "AQYA SHOP × TICKETY",
            iconURL: interaction.guild.iconURL({ dynamic: true }),
          });

        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === "partnerstwa") {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({
            content: "? Tylko administrator może ustawić kanał partnerstw.",
            ephemeral: true,
          });
        }

        const channel = interaction.options.getChannel("kanal");

        partnerData.settings.partnerChannelId = channel.id;
        savePartnerData();

        return interaction.reply({
          content: `? Kanał partnerstw ustawiony na ${channel}.`,
          ephemeral: true,
        });
      }

      if (commandName === "portfel") {
        const user = interaction.options.getUser("user") || interaction.user;
        const balance = partnerData.wallets[user.id] || 0;
        const activeLinks = Object.values(partnerData.links).filter(
          (link) => link.ownerId === user.id && Date.now() <= link.expiresAt
        ).length;
        const walletTable = [
          ["Pozycja", "Wartość"],
          ["Użytkownik", user.tag],
          ["Saldo", formatMoney(balance)],
          ["Aktywne linki", `${activeLinks}`],
        ]
          .map((row) => `${row[0].padEnd(14)} | ${row[1]}`)
          .join("\n");

        const walletEmbed = new EmbedBuilder()
          .setColor("#00ffff")
          .setTitle("AQYA SHOP × PORTFEL")
          .setDescription(`\`\`\`\n${walletTable}\n\`\`\``)
          .setThumbnail(user.displayAvatarURL({ dynamic: true }))
          .setFooter({
            text: "Partnerstwa ? 0,50 zł za użyty link",
            iconURL: interaction.guild.iconURL({ dynamic: true }),
          });

        return interaction.reply({ embeds: [walletEmbed] });
      }

      if (commandName === "zatwierdzpartnerstwo") {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({
            content: "? Tylko administrator może zatwierdzić partnerstwo.",
            ephemeral: true,
          });
        }

        const user = interaction.options.getUser("user");
        const activeLink = Object.entries(partnerData.links).find(
          ([, link]) => link.ownerId === user.id && Date.now() <= link.expiresAt
        );

        if (!activeLink) {
          return interaction.reply({
            content: `? ${user} nie ma aktywnego linku partnerstwa z ostatnich 2 dni.`,
            ephemeral: true,
          });
        }

        const [code, link] = activeLink;
        partnerData.wallets[user.id] = (partnerData.wallets[user.id] || 0) + PARTNER_REWARD_GROSZE;
        delete partnerData.links[code];
        savePartnerData();

        const approveTable = [
          ["Pozycja", "Wartość"],
          ["Użytkownik", user.tag],
          ["Nagroda", formatMoney(PARTNER_REWARD_GROSZE)],
          ["Link", link.guildName || "Partnerstwo"],
          ["Saldo", formatMoney(partnerData.wallets[user.id])],
        ]
          .map((row) => `${row[0].padEnd(12)} | ${row[1]}`)
          .join("\n");

        const approveEmbed = new EmbedBuilder()
          .setColor("#00ffff")
          .setTitle(" AQYA SHOP × PARTNERSTWO")
          .setDescription(`\`\`\`\n${approveTable}\n\`\`\``)
          .setFooter({
            text: "Partnerstwo zatwierdzone",
            iconURL: interaction.guild.iconURL({ dynamic: true }),
          });

        return interaction.reply({ embeds: [approveEmbed] });
      }

      if (commandName === "reset") {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({
            content: "? Tylko administrator może resetować partnerstwa.",
            ephemeral: true,
          });
        }

        partnerData.wallets = {};
        partnerData.links = {};
        savePartnerData();

        return interaction.reply({
          content: "? Zresetowano portfele i aktywne partnerstwa.",
          ephemeral: true,
        });
      }

      if (["mute", "kick", "ban"].includes(commandName)) {
        const permissionByCommand = {
          mute: PermissionsBitField.Flags.ModerateMembers,
          kick: PermissionsBitField.Flags.KickMembers,
          ban: PermissionsBitField.Flags.BanMembers,
        };

        const botPermissionByCommand = {
          mute: PermissionsBitField.Flags.ModerateMembers,
          kick: PermissionsBitField.Flags.KickMembers,
          ban: PermissionsBitField.Flags.BanMembers,
        };

        if (!interaction.member.permissions.has(permissionByCommand[commandName])) {
          return interaction.reply({
            content: " Nie masz uprawnień do użycia tej komendy.",
            ephemeral: true,
          });
        }

        const botMember = interaction.guild.members.me;

        if (!botMember.permissions.has(botPermissionByCommand[commandName])) {
          return interaction.reply({
            content: "? Bot nie ma wymaganych uprawnień do wykonania tej akcji.",
            ephemeral: true,
          });
        }

        const targetMember = interaction.options.getMember("user");
        const reason = interaction.options.getString("powod") || "Brak powodu";

        if (!targetMember) {
          return interaction.reply({
            content: "? Nie znaleziono tego użytkownika na serwerze.",
            ephemeral: true,
          });
        }

        if (targetMember.id === interaction.user.id) {
          return interaction.reply({
            content: " Nie możesz użyć tej komendy na sobie.",
            ephemeral: true,
          });
        }

        if (targetMember.id === client.user.id) {
          return interaction.reply({
            content: " Nie mogę użyć tej komendy na sobie.",
            ephemeral: true,
          });
        }

        if (targetMember.id === interaction.guild.ownerId) {
          return interaction.reply({
            content: " Nie można użyć tej komendy na właścicielu serwera.",
            ephemeral: true,
          });
        }

        if (
          interaction.member.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0 &&
          interaction.guild.ownerId !== interaction.user.id
        ) {
          return interaction.reply({
            content: "? Ta osoba ma rolę równą lub wyższą od Twojej.",
            ephemeral: true,
          });
        }

        if (commandName === "mute") {
          const minutes = interaction.options.getInteger("minuty") || 10;

          if (!targetMember.moderatable) {
            return interaction.reply({
              content: "? Nie mogę wyciszyć tej osoby. Sprawdź rolę bota.",
              ephemeral: true,
            });
          }

          await targetMember.timeout(
            minutes * 60 * 1000,
            `${reason} | Moderator: ${interaction.user.tag}`
          );

          const embed = createModerationEmbed(
            " Użytkownik wyciszony",
            [
              { name: " Użytkownik", value: `${targetMember.user}`, inline: true },
              { name: " Moderator", value: `${interaction.user}`, inline: true },
              { name: " Czas", value: `${minutes} min`, inline: true },
              { name: " Powód", value: reason, inline: false },
            ],
            interaction.guild
          );

          return interaction.reply({ embeds: [embed] });
        }

        if (commandName === "kick") {
          if (!targetMember.kickable) {
            return interaction.reply({
              content: "? Nie mogę wyrzucić tej osoby. Sprawdź rolę bota.",
              ephemeral: true,
            });
          }

          await targetMember.kick(`${reason} | Moderator: ${interaction.user.tag}`);

          const embed = createModerationEmbed(
            " Użytkownik wyrzucony",
            [
              { name: " Użytkownik", value: `${targetMember.user.tag}`, inline: true },
              { name: " Moderator", value: `${interaction.user}`, inline: true },
              { name: " Powód", value: reason, inline: false },
            ],
            interaction.guild
          );

          return interaction.reply({ embeds: [embed] });
        }

        if (commandName === "ban") {
          if (!targetMember.bannable) {
            return interaction.reply({
              content: "? Nie mogę zbanować tej osoby. Sprawdź rolę bota.",
              ephemeral: true,
            });
          }

          await targetMember.ban({ reason: `${reason} | Moderator: ${interaction.user.tag}` });

          const embed = createModerationEmbed(
            " Użytkownik zbanowany",
            [
              { name: " Użytkownik", value: `${targetMember.user.tag}`, inline: true },
              { name: " Moderator", value: `${interaction.user}`, inline: true },
              { name: " Powód", value: reason, inline: false },
            ],
            interaction.guild
          );

          return interaction.reply({ embeds: [embed] });
        }
      }

      const adminOnlyCommands = ["cennik", "weryfikacja", "konkurs"];

      if (
        adminOnlyCommands.includes(commandName) &&
        !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)
      ) {
        return interaction.reply({
          content: " Tylko administrator może używać tej komendy.",
          ephemeral: true,
        });
      }

      if (commandName === "konkurs") {
        await interaction.deferReply();
        const nagroda = interaction.options.getString("nagroda") || "Nagroda";
        const opis =
          interaction.options.getString("opis") ||
          "Kliknij przycisk ponizej, aby wziac udzial.";
        const czas = interaction.options.getInteger("czas") || 10;

        const konkursId = `${Date.now()}`;
        const koniec = Math.floor((Date.now() + czas * 60 * 1000) / 1000);

        const joinButton = new ButtonBuilder()
          .setCustomId(`konkurs_join_${konkursId}`)
          .setLabel("Wez udzial")
          .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(joinButton);

        const embed = new EmbedBuilder()
          .setColor("#00ffff")
          .setTitle("` AQYA SHOP × KONKURS`")
          .addFields(
            { name: " Nagroda", value: `**${nagroda}**`, inline: false },
            { name: " Czas", value: `**${czas} minut**`, inline: true },
            { name: " Koniec", value: `<t:${koniec}:R>`, inline: true },
            { name: " Opis", value: opis, inline: false },
            { name: " Uczestnicy", value: "**0**", inline: true }
          )
          .setFooter({
            text: "AQYA SHOP × KONKURSY",
            iconURL: interaction.guild.iconURL({ dynamic: true }),
          });

        await interaction.editReply({ embeds: [embed], components: [row] });

        const message = await interaction.fetchReply();

        konkursy.set(konkursId, {
          nagroda,
          opis,
          uczestnicy: new Set(),
          channelId: message.channel.id,
          messageId: message.id,
        });

        setTimeout(() => {
          zakonczKonkurs(konkursId);
        }, czas * 60 * 1000);

        return;
      }

      if (commandName === "drop") {
        await interaction.deferReply();

        const now = Date.now();
        const lastUse = dropCooldowns.get(interaction.user.id) || 0;
        const timeLeft = DROP_COOLDOWN - (now - lastUse);

        if (timeLeft > 0) {
          const nextUse = Math.floor((lastUse + DROP_COOLDOWN) / 1000);

          const cooldownEmbed = new EmbedBuilder()
            .setColor("#00ffff")
            .setTitle(" AQYA SHOP × DROP")
            .addFields(
              { name: " Użytkownik", value: `${interaction.user}`, inline: true },
              {
                name: " Wynik",
                value: "? Juz użyće? dropa. Spr?buj ponownie p?zniej.",
                inline: true,
              },
              { name: " Następne użycie", value: `<t:${nextUse}:R>`, inline: true }
            )
            .setFooter({
              text: "AQYA SHOP × DROP",
              iconURL: interaction.guild.iconURL({ dynamic: true }),
            });

          return interaction.editReply({ embeds: [cooldownEmbed] });
        }

        dropCooldowns.set(interaction.user.id, now);

        const wygrana = Math.random() < 0.01;
        const nextUse = Math.floor((now + DROP_COOLDOWN) / 1000);

        const dropEmbed = new EmbedBuilder()
          .setColor("#00ffff")
          .setTitle("AQYA SHOP × DROP")
          .addFields(
            { name: " Użytkownik", value: `${interaction.user}`, inline: true },
            { name: " Wynik", value: wygrana ? " 2 zł zniżki" : "Pusto", inline: true },
            { name: " Kolejna pr?ba", value: `<t:${nextUse}:R>`, inline: true }
          )
          .setFooter({
            text: "AQYA SHOP × DROP",
            iconURL: interaction.guild.iconURL({ dynamic: true }),
          });

        return interaction.editReply({ embeds: [dropEmbed] });
      }

      if (commandName === "weryfikacja") {
        await interaction.deferReply();
        const verifyButton = new ButtonBuilder()
          .setCustomId("verify")
          .setLabel("Zweryfikuj sie")
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(verifyButton);

        const embed = new EmbedBuilder()
          .setColor("#00ffff")
          .setTitle("` AQYA SHOP × WERYFIKACJA`")
          .setDescription("Kliknij przycisk ponizej, aby sie zweryfikowac.")
          .setFooter({
            text: " 2026 AQYA SHOP × WERYFIKACJA",
            iconURL: interaction.guild.iconURL({ dynamic: true }),
          });

        return interaction.editReply({ embeds: [embed], components: [row] });
      }

      if (commandName === "cennik") {
        await interaction.deferReply();
        const menu = new StringSelectMenuBuilder()
          .setCustomId("my_dropdown")
          .setPlaceholder(" Nie wybrałeś/aś żadnego cennika")
          .addOptions([
            { label: "> cennik-sab", description: "sab", value: "opcja_1" },
            { label: "> mystery-sab", description: "sab", value: "opcja_2" },
            { label: "> index-bazy", description: "sab", value: "opcja_3" },
            { label: "> case-paradise", description: "case", value: "opcja_4" },
            { label: "> Ps99", description: "ps99", value: "opcja_5" },
            { label: "> robux", description: "robux", value: "opcja_6" },
            
          ]);

        const row = new ActionRowBuilder().addComponents(menu);

        const embed = new EmbedBuilder()
          .setColor("#00ffff")
          .setTitle("` AQYA SHOP × CENNIK`")
          .setDescription(" Aby zobaczyc cennik wybierz jedna z dostępnych kategorii.")
          .setFooter({
            text: " 2026 AQYA SHOP × CENNIK",
            iconURL: interaction.guild.iconURL({ dynamic: true }),
          });

        return interaction.editReply({ embeds: [embed], components: [row] });
      }

      if (commandName === "tickets") {
        await interaction.deferReply();
        const menu = new StringSelectMenuBuilder()
          .setCustomId("ticket_select")
          .setPlaceholder(" Nie wybrałeś/aś zadnej kategorii.")
          .addOptions([
            { label: "Zakup", description: "Otwórz ticket dotyczłcy zakupu", value: "zakup" },
            { label: "Skup", description: "Otwórz ticket dotyczłcy skupu", value: "skup" },
            { label: "Index", description: "Otwórz ticket dotyczłcy indexu", value: "index" },
            { label: "Middleman", description: "Otwórz ticket dotyczłcy middlemana", value: "middleman" },
            { label: "Pomoc", description: "Otwórz ticket po pomoc administracji", value: "pomoc" },
          ]);

        const row = new ActionRowBuilder().addComponents(menu);

        const embed = new EmbedBuilder()
          .setColor("#00ffff")
          .setTitle("` AQYA SHOP × TICKETY`")
          .setDescription(" Aby stworzyc ticketa wybierz jedna z dostępnych kategorii.")
          .setFooter({
            text: " 2026 AQYA SHOP × TICKETY",
            iconURL: interaction.guild.iconURL({ dynamic: true }),
          });

        return interaction.editReply({ embeds: [embed], components: [row] });
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "my_dropdown") {
        const choice = interaction.values[0];

        const cenniki = {
          opcja_1: { title: " AQYA SHOP × CENNIK SAB", table: [["Produkt", "Cena"], ["Soon", "? zł"], ["Soon", "? zł"], ["Soon", "? zł"]] },
          opcja_2: { title: " AQYA SHOP × MYSTERY SAB", table: [["Produkt", "Cena"], ["Soon", "? zł"], ["Soon", "? zł"], ["Soon", "? zł"]] },
          opcja_3: { title: " AQYA SHOP × INDEX BAZY", table: [["Produkt", "Cena"], ["Soon", "? zł"], ["Soon", "? zł"], ["Soon", "? zł"]] },
          opcja_4: { title: " AQYA SHOP × CASE PARADISE", table: [["Produkt", "Cena"], ["Soon", "? zł"], ["Soon", "? zł"], ["Soon", "? zł"]] },
          opcja_5: { title: " AQYA SHOP × PS99", table: [["Produkt", "Cena"], ["Soon", "? zł"], ["Soon", "? zł"], ["Soon", "? zł"]] },
          opcja_6: { title: " AQYA SHOP × ROBUX", table: [["Produkt", "Cena"], ["Soon", "? zł"]] },
        
        };

        const selected = cenniki[choice];
        if (!selected) return;

        const tableText = selected.table
          .map((row) => `${row[0].padEnd(18)} | ${row[1]}`)
          .join("\n");

        const embed = new EmbedBuilder()
          .setColor("#00ffff")
          .setTitle(selected.title)
          .setDescription(`\`\`\`\n${tableText}\n\`\`\``)
          .setFooter({
            text: " 2026 AQYA SHOP × CENNIK",
            iconURL: interaction.guild.iconURL({ dynamic: true }),
          });

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (interaction.customId === "ticket_select") {
        const choice = interaction.values[0];

        if (choice === "zakup") {
          const modal = new ModalBuilder()
            .setCustomId("ticket_zakup_modal")
            .setTitle("Zakup");

          const itemInput = new TextInputBuilder()
            .setCustomId("zakup_item")
            .setLabel("Co chcesz kupic?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("np. SAB, Robux, PS99")
            .setRequired(true);

          const budgetInput = new TextInputBuilder()
            .setCustomId("zakup_budget")
            .setLabel("Jaki masz budżet?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("np. 20 zl, 50 zl, 100 zl")
            .setRequired(true);

          const paymentInput = new TextInputBuilder()
            .setCustomId("zakup_payment")
            .setLabel("Czym p?aciszł")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("np. BLIK, PayPal, PSC")
            .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder().addComponents(itemInput),
            new ActionRowBuilder().addComponents(budgetInput),
            new ActionRowBuilder().addComponents(paymentInput)
          );

          return interaction.showModal(modal);
        }

        return createTicket(interaction, choice);
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "ticket_zakup_modal") {
        const item = interaction.fields.getTextInputValue("zakup_item");
        const budget = interaction.fields.getTextInputValue("zakup_budget");
        const payment = interaction.fields.getTextInputValue("zakup_payment");

        return createTicket(interaction, "zakup", { item, budget, payment });
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith("konkurs_join_")) {
        const konkursId = interaction.customId.replace("konkurs_join_", "");
        const konkurs = konkursy.get(konkursId);

        if (!konkurs) {
          return interaction.reply({
            content: "Ten konkurs już sie zakonczyl.",
            ephemeral: true,
          });
        }

        if (konkurs.uczestnicy.has(interaction.user.id)) {
          return interaction.reply({
            content: "Juz bierzesz udzial w tym konkursie.",
            ephemeral: true,
          });
        }

        konkurs.uczestnicy.add(interaction.user.id);

        const channel = await client.channels.fetch(konkurs.channelId).catch(() => null);
        const message = await channel?.messages.fetch(konkurs.messageId).catch(() => null);

        if (message?.embeds[0]) {
          const updatedEmbed = EmbedBuilder.from(message.embeds[0]);
          const fields = message.embeds[0].fields.map((field) =>
            field.name === " Uczestnicy"
              ? { name: " Uczestnicy", value: `**${konkurs.uczestnicy.size}**`, inline: true }
              : field
          );

          updatedEmbed.setFields(fields);
          await message.edit({ embeds: [updatedEmbed] }).catch(() => null);
        }

        return interaction.reply({
          content: `Dolaczyles do konkursu o **${konkurs.nagroda}**!`,
          ephemeral: true,
        });
      }

      if (interaction.customId === "verify") {
        const member = interaction.member;
        const role = await interaction.guild.roles.fetch(VERIFIED_ROLE_ID).catch(() => null);
        const role2 = await interaction.guild.roles.fetch(VERIFIED_ROLE_ID_2).catch(() => null);

        if (!role || !role2) {
          return interaction.reply({
            content: "Nie znaleziono jednej z r?l weryfikacyjnych. Sprawdź ID r?l i czy bot jest na dobrym serwerze.",
            ephemeral: true,
          });
        }

        if (member.roles.cache.has(role.id) && member.roles.cache.has(role2.id)){
          return interaction.reply({
            content: "Juz jestes zweryfikowany.",
            ephemeral: true,
          });
        }

        await member.roles.add([role]);

        return interaction.reply({
          content: "Zostales zweryfikowany!",
          ephemeral: true,
        });
      }

      if (interaction.customId === "ticket_close") {
        if (!isTicketChannel(interaction.channel)) {
          return interaction.reply({
            content: "? To nie jest ticket!",
            ephemeral: true,
          });
        }

        await interaction.reply({
          content: " Ticket zostanie zamknięty za 3 sekundy...",
          ephemeral: true,
        });

        setTimeout(() => {
          interaction.channel.delete().catch(console.error);
        }, 3000);
      }
    }
  } catch (err) {
    console.error(err);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `❌ Wystąpił błąd podczas obsługi tej akcji.`,
        ephemeral: true,
      }).catch(() => null);
    }
  }
});

client.login(process.env.TOKEN);
