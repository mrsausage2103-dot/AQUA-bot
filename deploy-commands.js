require("dotenv").config();

const { REST, Routes, SlashCommandBuilder, ChannelType } = require("discord.js");

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
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log("Rejestrowanie komend...");

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );

    console.log("Komendy zarejestrowane.");
  } catch (error) {
    console.error(error);
  }
})();
