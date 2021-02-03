import * as OSC from 'osc-js';

// OSC server (port to listen to ZoomOSC and clients)
// Our Listener
const zoomInPort = process.env.LISTEN_PORT || 1234;

// Our sender (ZoomOSC listener)
const zoomOutHost = process.env.ZOOMOSC_HOST || 'localhost';
const zoomOutPort = process.env.ZOOMOSC_PORT || 9090;

const udpOptions = {
    open: {
        port: zoomInPort,
    },
    send: {
        port: zoomOutPort,
        host: zoomOutHost
    }
}

const osc = new OSC({
    discardLateMessages: false,
    plugin: new OSC.DatagramPlugin(udpOptions)
});

interface RoomState {
    count: number;
    names: Map<string, number>;
    leaders: number[];
    everyone: Map<number, PersonState>;
}

interface PersonState {
    zoomID: number;
    userName: string;
    audioOn: boolean;
    videoOn: boolean;
}

interface ZoomOSCMessage {
    address: string;
    targetID: number;
    userName: string;
    galIndex: number;
    zoomID: number;
    params: string;
}

const state: RoomState = {
    count: 0,
    names: new Map<string, number>(),
    leaders: [],
    everyone: new Map<number, PersonState>()
}

run()
    .then(() => {
        console.log('running');
    });

async function run() {
    setupOscListeners();
    osc.open();
    console.log(`Listening to ${ osc.options.plugin.options.open.host }:${ osc.options.plugin.options.open.port }`);

    await sendToZoom('/zoom/subscribe', 2);
}

async function sendToZoom(message: string, ...args: any[]): Promise<any> {
    console.log("Sending to Zoom: %s, %s", message, args);
    try {
        osc.send(new OSC.Message(message, ...args));
    } catch (e) {
        console.error("Failed to sendToZoom", e);
    }
}

function parseZoomOSCMessage(message) {
    console.log("raw message:", message);

    const [address, targetID, userName, galIndex, zoomID, params] = [message.address, ...message.args];

    return {
        address: address,
        targetID: Number(targetID),
        userName: userName,
        galIndex: Number(galIndex),
        zoomID: Number(zoomID),
        params: params
    }
}

// noinspection JSUnusedLocalSymbols
function handleZoomOSCMessage(message: ZoomOSCMessage) {
    console.log("handleZoomOSCMessage:", message);

    const addressParts = message.address.split('/');
    if (addressParts.length < 4) {
        return;
    }

    console.log("handleZoomOSCMessage addressParts", addressParts);

    switch (addressParts[3]) {
        case 'chat':
            handleChatMessage(message);
    }
}

function handleChatMessage(message: ZoomOSCMessage) {
    const chatMessage = message.params;
    if (chatMessage[0] === '/') {
        // slash-command, do something with it

        const params = parseChatParams(chatMessage);
        console.log("args", params);
        switch (params[0]) {
            case '/mx': // mute all except
                sendToZoom('/zoom/allExcept/userName/mute', params[1]);
                break;
            case '/ua': // unmute all
                sendToZoom('/zoom/all/unMute');
                break;
            case '/ma': // mute all
                sendToZoom('/zoom/all/mute');
                break;
        }
    }
}

function parseChatParams(str: string): string[] {
    return (str
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .match(/[^\s"]+|"([^"]*)"/gi) || []).map((word) =>
        word.replace(/^"(.+(?="$))"$/, '$1'));
}

function handleUnmute(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    person.audioOn = true;
}

function handleMute(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    person.audioOn = false;
}

function handleVideoOn(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    person.videoOn = true;
}

function handleVideoOff(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    person.videoOn = false;
}

function handleList(message: ZoomOSCMessage) {
    let person: PersonState = state.everyone.get(message.zoomID);
    if (!person) {
        person = {
            zoomID: message.zoomID,
            userName: message.userName,
            audioOn: Boolean(message.params[5]),
            videoOn: Boolean(message.params[4])
        }
    }
    state.everyone.set(person.zoomID, person);
}

function setupOscListeners() {

    // osc.on('*', message => {
    //     console.log("OSC * Message", message)
    // });

    osc.on('/zoomosc/user/chat', async message => handleChatMessage(parseZoomOSCMessage(message)));

    // osc.on('/zoomosc/user/*', async message => handleZoomOSCMessage(parseZoomOSCMessage(message)));
    // osc.on('/zoomosc/me/*', async message => handleZoomOSCMessage(parseZoomOSCMessage(message)));

    // osc.on('/zoomosc/audioStatus', async message => console.log("/zoomosc/audioStatus", message.args));
    //
    osc.on('/zoomosc/user/unMute', async message => handleUnmute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/mute', async message => handleMute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/videoOn', async message => handleVideoOn(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/videoOff', async message => handleVideoOff(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/list', async message => handleList(parseZoomOSCMessage(message)));
    //
    // osc.on('/zoomosc/galleryOrder', async message => console.log("/zoomosc/galleryOrder", message.args));
    // osc.on('/zoomosc/galleryCount', async message => console.log("/zoomosc/galleryCount", message.args));
    // osc.on('/zoomosc/galleryShape', async message => console.log("/zoomosc/galleryShape", message.args));
}

// noinspection JSUnusedLocalSymbols
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
