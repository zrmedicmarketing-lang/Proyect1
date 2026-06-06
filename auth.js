const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");

const credentials = JSON.parse(
  fs.readFileSync("credentials.json")
);

const { client_secret, client_id, redirect_uris } =
  credentials.installed;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly"
];

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES
});

console.log("\nAbre este link:\n");
console.log(authUrl);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question("\nPega el código aquí: ", async (code) => {

  const { tokens } =
    await oAuth2Client.getToken(code);

  oAuth2Client.setCredentials(tokens);

  fs.writeFileSync(
    "token.json",
    JSON.stringify(tokens)
  );

  console.log("\n✅ token.json creado");

  rl.close();
});