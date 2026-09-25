<<<<<<< HEAD
const { spawn } = require("child_process");
const path = require("path");

const serverPath = path.join(
    __dirname,
    "server.js"
);

console.log("");
console.log("==============================================");
console.log("🏋️ INICIANDO SQUAT TWITCH SERVER");
console.log("==============================================");
console.log("");

const server = spawn(
    process.execPath,
    [serverPath],
    {
        cwd: __dirname,
        detached: false,
        stdio: "inherit",
        windowsHide: false
    }
);

server.on("error", (error) => {

    console.error("");
    console.error("❌ No se pudo iniciar el servidor:");
    console.error(error);

});

server.on("exit", (code) => {

    console.log("");
    console.log(
        `🛑 Squat Twitch Server terminó. Código: ${code}`
    );

=======
const { spawn } = require("child_process");
const path = require("path");

const serverPath = path.join(
    __dirname,
    "server.js"
);

console.log("");
console.log("==============================================");
console.log("🏋️ INICIANDO SQUAT TWITCH SERVER");
console.log("==============================================");
console.log("");

const server = spawn(
    process.execPath,
    [serverPath],
    {
        cwd: __dirname,
        detached: false,
        stdio: "inherit",
        windowsHide: false
    }
);

server.on("error", (error) => {

    console.error("");
    console.error("❌ No se pudo iniciar el servidor:");
    console.error(error);

});

server.on("exit", (code) => {

    console.log("");
    console.log(
        `🛑 Squat Twitch Server terminó. Código: ${code}`
    );

>>>>>>> 87e2c85 (version 1.0.0)
});