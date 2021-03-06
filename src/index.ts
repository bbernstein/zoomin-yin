import * as fs from 'fs';
import * as OSC from 'osc-js';
import {
    ChronoUnit,
    DateTimeFormatter,
    Duration,
    LocalDate,
    LocalDateTime,
    LocalTime
} from '@js-joda/core';
import { rawListeners } from 'process';
import { BooleanLiteral } from 'typescript';

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

const USERROLE_NONE = 0;
const USERROLE_HOST = 1;
const USERROLE_COHOST = 2;
const DEFAULT_MX_GRP = "leaders";
const LS_SUPPORT_GRP = "ls-support";      // Must assign a group called "ls-support"
const ZOOMOSC_DEVICES_GRP = "oscdevices"; // Used to mirror state on secondary devices
const PRIMARY_USER = "zoomin-yin";        // Try to figure out whoami by asking the Primary User"
const SKIP_PC = -1;
const SKIP_PC_STRING = "-";
const ADDTOGRP = true;
const CONFIG_POLL_TIME = 15000;
const DEFAULT_DURATION = "PT1H";
const DEFAULT_ADD_MINUTES = 5;
const ENDOFMEETING_WARNING_WINDOW = 5;    // In minutes
const DEFAULT_MUTE_UPON_ENTRY = "20"; 

// const SKIP_CURRENT = true;
// const DONT_SKIP_CURRENT = false;

// for testing, fill in the date/time for "now" to see what happens, otherwise set it to null
// (comment out one of these two)
// const fakeNow = LocalDateTime.of(
//     LocalDate.parse("2021-04-21", DateTimeFormatter.ISO_LOCAL_DATE),
//     LocalTime.parse("09:15", DateTimeFormatter.ofPattern('HH:mm'))
// );
const fakeNow = null;


let primaryMode = true;
let myName = null;
let myZoomID: Number = null;

// The definition of the current state of the room
interface RoomState {
    // mapping names to their zoomIDs
    names: Map<string, number[]>;

    // custom groups of users
    groups: Map<string, number[]>;

    // everyone's state
    everyone: Map<number, PersonState>;
}

// What we keep track of for each person
interface PersonState {
    zoomID: number;
    userName: string;
    userRole: number;
    onlineStatus: boolean;
    videoOn: boolean;
    audioOn: boolean;
    visited: boolean;
}

// The ZoomOSC incoming user message with params broken out
interface ZoomOSCMessage {
    rawZoomMessage: OSC.message;

    address: string;
    targetID: number;
    userName: string;
    galIndex: number;
    zoomID: number;
    params: string;

    // List output parameters
    targetCount: number;
    listCount: number;
    userRole: number;
    onlineStatus: boolean;
    videoStatus: boolean;
    audioStatus: boolean;
    handRaised: boolean;

    // Pong output parameters
    pingArg: any;
    zoomOSCversion: string;
    subscribeMode: number;
    galTrackMode: number;
    callStatus: number;
    numTargets: number;
    numUsers: number;
    isPro: boolean;
}

// The ZoomOSC incoming user message with params broken out
interface PongReply {
    pingArg: any;
    zoomOSCversion: string;
    subscribeMode: number;
    galTrackMode: number;
    callStatus: number;
    numTargets: number;
    numUsers: number;
    isPro: boolean;
}

// The value of the room state
const state: RoomState = {
    names: new Map<string, number[]>(),
    groups: new Map<string, number[]>(),
    everyone: new Map<number, PersonState>()
}

interface MeetingConfig {
    name: string;
    exclude?: string;
    meetingID: string;
    meetingPass?: string;
    userName?: string;
    coHosts?: string[];
    muteUponEntry?: string;
    date?: string;
    time?: string;
    duration?: string;
    maxDuration?: string;
    codeWord?: string;
    startDateTime?: LocalDateTime;
    endDateTime?: LocalDateTime;
    maxEndDateTime?: LocalDateTime;
}

interface Config {
    default: string;
    defaultCodeWord: string;
    meetings: MeetingConfig[];
}

let ZoomOSCInfo: PongReply;
let gCurrentMeetingConfig: MeetingConfig;
let gDefaultCodeWord: string;
let disableStartMeeting = false;
let configLastModified: number;
let configFileChecked = false;   // Used to limit numnber of warnings/errors in calculateMeeting

// get this thing started
run()
    .then(() => {
        sendMessage(null,`running ...`);
    });

// use this so we can test with fake "current" times easily (there are other ways, but its a little complicated)
function getNow(): LocalDateTime {
    return fakeNow || LocalDateTime.now();
}

async function readConfig(): Promise<Config> {
    const configFile = fs.readFileSync('config.json');
    const config = JSON.parse(configFile.toString());
    gDefaultCodeWord = config.defaultCodeWord;
    config.meetings = calculateMeetingTimes(config.meetings);
    return config;
}

function calculateMeetingTimes(meetings: MeetingConfig[]): MeetingConfig[] {
    const today = getNow().toLocalDate();

    /**
     * Make a list of meetings that include their LocalDateTime versions.
     * Sorted by start time
     * With all conflicts removed or reported.
     * If a default meeting (no date given) overlaps with a dated meeting, it is removed
     * If two dated or default meetings overlap, they are reported with warning
     */
    const orderedMeetings =
        meetings.map(meeting => {

            if (!meeting.codeWord) {
                meeting.codeWord = gDefaultCodeWord;
            }

            if (!meeting.time) return;
            const date = meeting.date
                ? LocalDate.parse(meeting.date, DateTimeFormatter.ISO_LOCAL_DATE)
                : today;
            const time = LocalTime.parse(meeting.time, DateTimeFormatter.ofPattern('HH:mm'));
            meeting.startDateTime = LocalDateTime.of(date, time);

            // calculate endDateTime from the start and duration
            const duration =
                meeting.duration
                    ? Duration.parse(meeting.duration)
                    : Duration.parse(DEFAULT_DURATION);
            meeting.endDateTime = meeting.startDateTime.plus(duration);

            // calculate maxEndDateTime from the start and maxDuration (default is duration from above)
            const maxDuration =
                meeting.maxDuration
                    ? Duration.parse(meeting.maxDuration)
                    : duration;
            meeting.maxEndDateTime = meeting.startDateTime.plus(maxDuration);

            // maxEndDateTime must be after the scheduled endDateTime
            if (meeting.maxEndDateTime.isBefore(meeting.endDateTime)) meeting.maxEndDateTime = meeting.endDateTime;

            // Use the default codeWord if one isn't specified in the config for this meeting.
            if (!meeting.codeWord) meeting.codeWord = gDefaultCodeWord;

            return meeting;
        })

            // sort them by startDates
            .sort(compareMeetingDates);

    // get only meetings that either have a date or are undated with no overlapping dated meetings
    const filteredMeetings = orderedMeetings
        .filter(meeting => {
            // don't filter out one with a date
            if (meeting.date) return true;

            // find a meeting that has a date && overlaps this meeting (if so, filter it out)
            const overlappingMeeting = orderedMeetings.find(otherMeeting => {
                return otherMeeting.date && overlaps(meeting, otherMeeting)
            });
            if (!configFileChecked && overlappingMeeting) {
                // found an overlap, report a warning
                console.error(`WARNING: ignoring default meeting: [${ toShortString(meeting) }]. Overridden by [${ toShortString(overlappingMeeting) }]`);
            }
            return !overlappingMeeting && !meeting.exclude;
        });

    // no changes, just report any overlaps remaining between meetings of same priority
    filteredMeetings.forEach(meeting => {
        const overlappingMeetings = filteredMeetings.filter(otherMeeting =>
            meeting !== otherMeeting &&
            meeting.startDateTime.compareTo(otherMeeting.startDateTime) >= 0 &&
            overlaps(meeting, otherMeeting));

        if (!configFileChecked && overlappingMeetings.length > 0) {
            // report all of the overlaps with this meeting (could repeat when multiple start at same time
            overlappingMeetings.forEach(om => {
                console.error(`WARNING: conflicting meetings: [${ toShortString(meeting) }] overlaps [${ toShortString(om) }]`);
            })
        }
    });

    return filteredMeetings;
}

/**
 * This is a simple string to identify a meeting
 *
 * TODO: You may want to add more fields. This is for output in a single line.
 * Another function could be written to show all the details
 */
function toShortString(meeting: MeetingConfig): string {
    return `${ meeting.name } / ${ meeting.date ? meeting.date : "UNDATED" } / ${ meeting.time }`;
}


function overlaps(meeting1: MeetingConfig, meeting2: MeetingConfig): boolean {
    // note: if one starts at the same time the other ends, it's still no overlap (hence "or equals")
    return meeting1.startDateTime.compareTo(meeting2.endDateTime) <= 0 &&
        meeting2.startDateTime.compareTo(meeting1.endDateTime) <= 0;
}

function startMeeting(meetingConfig: MeetingConfig) {

    if (!meetingConfig || (meetingConfig.exclude == "true")) return;

    const now = getNow();

    const startTime = meetingConfig.startDateTime;
    const duration = Duration.parse(meetingConfig.duration);
    // Start/Join meeting if it's the current meeting
    if (now.isEqual(startTime) || (now.isAfter(startTime) && now.isBefore(startTime.plus(duration)))) {
        sendMessage(null, "startMeeting: Start/Join Meeting", meetingConfig);

        if (!ZoomOSCInfo.isPro) {
            sendMessage(null, "Error: Unable to start meeting - Must be running ZoomOSC Pro");
        }

        const spacelessMeetingId = String(meetingConfig.meetingID).replace(/ /g, "");
        if (meetingConfig.meetingPass) {
            sendToZoom('/zoom/joinMeeting', spacelessMeetingId, meetingConfig.meetingPass, meetingConfig.userName);
        } else {
            sendToZoom('/zoom/joinMeeting', spacelessMeetingId, meetingConfig.userName);
        }
    }

    // keep this global so we can check its codeword and things like that
    gCurrentMeetingConfig = meetingConfig;

    // FIXME: ZoomOSC doesn't support "Mute Participants upon Entry"
    //        For now, manually mute people upon entry after specified number of people have joined the meeting
    if (!meetingConfig.muteUponEntry) {
        gCurrentMeetingConfig.muteUponEntry = DEFAULT_MUTE_UPON_ENTRY;
    }

    // Stop trying to start a new meeting until this one has ended.
    disableStartMeeting = true;
}

// return -1 if meeting1 is lower, 1 if meeting2 is lower, 0 if they are equal
function compareMeetingDates(meeting1, meeting2): number {
    return meeting1.startDateTime.compareTo(meeting2.startDateTime)
}

/**
 * Return the meeting that was scheduled to have started in the past but hasn't yet ended
 * If there are multiple meetings now, it will return the first one that has today's date
 */
function currentMeeting(meetings: MeetingConfig[]): MeetingConfig {
    const now = getNow();
    const allCurrentMeetings = meetings

        // only include meetings that had already started and haven't yet ended
        .filter(meeting => meeting.startDateTime.compareTo(now) <= 0 && meeting.endDateTime.compareTo(now) >= 0)

        // ones that have a date take priority over ones that don't
        .sort(compareMeetingDates);

    // if there was at least one match, return the first. They are sorted so that dated ones come before defaults
    return allCurrentMeetings.length > 0 && allCurrentMeetings[0];
}

/**
 * Return the next meeting that hasn't yet started.
 * If there are multiple meetings coming up at the same time, it will choose the one that is scheduled for today.
 * TODO: this isn't used right now
 */
function nextMeeting(meetings: MeetingConfig[]): MeetingConfig {
    const now = getNow();

    const allFutureMeetings = meetings

        // filter to only include possible future meetings (or current)
        .filter(meeting => {

            // only include meetings that haven't started yet
            return meeting.startDateTime && (meeting.startDateTime.compareTo(now) >= 0);
        })

        // sort in order so the next one is the first
        .sort(compareMeetingDates);

    return allFutureMeetings.length > 0 && allFutureMeetings[0];
}

async function run() {
    let initialCallStatus = null;

    // prepare to listen to OSC
    setupOscListeners();

    // start listening
    osc.open();
    sendMessage(null, `Listening to ${osc.options.plugin.options.open.host}:${osc.options.plugin.options.open.port}`);

    // FIXME: Clean this up
    // Get ZoomOSCInfo
    // If the ZoomOSC is running locally the /pong response will be available pretty quickly.  If not, poll until it is
    // Note: There is nothing else to do until the operating mode is known
    sendToZoom('/zoom/ping', "ZoomOSC Information");
    await sleep(1000); 
    while (!ZoomOSCInfo) {
        sendToZoom('/zoom/ping', "ZoomOSC Information");
        await sleep(5000);
    }

    // tell ZoomOSC to listen to updates about the users
    // FIXME: This is not reliable if ZoomOSC is configued with "Subscribe to: = None"
    // sendToZoom('/zoom/subscribe', 2);

    // If running ZoomOSC PRO, then operate in Primary mode
    primaryMode = ZoomOSCInfo.isPro;
    initialCallStatus = ZoomOSCInfo.callStatus;

    // read the config file and start/join the current meeting (if not already started)
    if (primaryMode) {

        // Config file
        // Notes about time / date formats
        //   Duration in ISO8601 formats:
        //   duration format: https://www.digi.com/resources/documentation/digidocs/90001437-13/reference/r_iso_8601_duration_format.htm
        //   Date format: HHHH-MM-DD
        //   Time format: hh:mm (24-hour time)
        //   Duration formation simple form: PT2H15M
        //      PT: Period Time       2H: two hours       15M: fifteen minutes

        await checkForUpdates();
    } 

    // Ignore meetings started by checkForUpdates
    if (!initialCallStatus) return;

    // This covers the case where the meeting is in progress and this script was restarted. 
    if (primaryMode) {
        // Let everyone know in the meeting that the Primary was restarted and they should send /whoami
        // so oscdevices can be restored.  
        // Everyone needs to be asked, because the Primary no longer knows who is running ZoomOSC
        if (ZoomOSCInfo.numUsers > 1) {
            sendToZoom('/zoom/list');
            await sleep(2000);
            sendToZoom('/zoom/all/chat', `/primaryrestarted`);
        }
    } else {
        await getWhoami();
    }
}

async function getWhoami() {

    await sleep(2000);

    if (primaryMode) {
        // /list command will update myZoomID
        sendToZoom('/zoom/list');
        await sleep(2000);
    } else {
        // Ask the Primary user whoami
        // If the Primary is online, the /list response will update the myZoomID fairly quickly, If not, poll until it is.
        // There is nothing else to do until whoami is known
        sendToZoom('/zoom/userName/chat', PRIMARY_USER, `/whoami`);
        sendToZoom('/zoom/ping', "ZoomOSC Information");
        await sleep(2000);
        while (!myZoomID && ZoomOSCInfo.callStatus) {
            sendToZoom('/zoom/userName/chat', PRIMARY_USER, `/whoami`);
            await sleep(5000);
        }
        // Update the state
        sendToZoom('/zoom/list');
    }

    reportZoomOSCInfo();
}

function reportZoomOSCInfo() {
    sendMessage(null, `--------------------------------------------------------------------------------`);
    if (ZoomOSCInfo && ZoomOSCInfo.callStatus) {
        sendMessage(null, `Running in ${primaryMode ? "Primary" : "Secondary"} mode as User: "${myName}", ZoomID: ${myZoomID}`);
    } else {
        sendMessage(null, `Running in ${primaryMode ? "Primary" : "Secondary"} mode - Meeting is not in progress`);
    }
    sendMessage(null, `--------------------------------------------------------------------------------`);
}

async function checkForUpdates() {

    const now = getNow();

    // Manage flags to indicate when the config file should be read
    // Once a meeting is started, stop trying to start a new one until the current meeting has ended.

    // If the config file has been modified, clear start meeting flags and see if there is a meeting to start
    const configFileStats = fs.statSync('config.json');
    const mtimeMs = configFileStats.mtimeMs;
    if (!configLastModified || (mtimeMs !== configLastModified)) {
        sendMessage(null,"readConfig: config file has been modified")
        configLastModified = mtimeMs;
        disableStartMeeting = false;
        gCurrentMeetingConfig = null;
        configFileChecked = false;
    }

    // Start/Join the current meeting if one exists
    if (!disableStartMeeting) {
        const config = await readConfig();
        const meeting = currentMeeting(config.meetings);

        startMeeting(meeting);

        // Set flag to mask future Warnings/Errors in calculateMeeting
        configFileChecked = true;
    }

    // After the scheduled end time of the current meeting it's OK to start the next meeting
    if (gCurrentMeetingConfig && now.isAfter(gCurrentMeetingConfig.endDateTime)) {
        disableStartMeeting = false;
    }

    // Stop the current meeting if it has reached the maxDuration
    if (gCurrentMeetingConfig && now.isAfter(gCurrentMeetingConfig.maxEndDateTime)) {
        if (!ZoomOSCInfo.isPro) {
            sendMessage(null, "Error: Unable to stop meeting - Must be running ZoomOSC Pro");
        }
        sendToZoom("/zoom/endMeeting");
        disableStartMeeting = false;
        gCurrentMeetingConfig = null;
    }

    // Starting ~5 minutes before the MaxDuration, send warnings to the host and co-hosts that the meeting will end 
    if (gCurrentMeetingConfig && (now.isAfter(gCurrentMeetingConfig.maxEndDateTime.minusMinutes(ENDOFMEETING_WARNING_WINDOW)))) {
        const endtime = gCurrentMeetingConfig.maxEndDateTime.format(DateTimeFormatter.ofPattern('hh:mm'));
        sendMessageToHosts(`Warning: The meeting will be terminated at approximately: ${endtime}\nTo extended the endtime, use the /keeprunning <min> <code> command`);
    }

    // Make users cohost based on the meeting config
    if (gCurrentMeetingConfig && gCurrentMeetingConfig.coHosts) {
        gCurrentMeetingConfig.coHosts.forEach(name => {
            const person = getPeopleFromName(name);
            // Make this person a cohost if not already one
            if (!person || isHost(person[0].zoomID)) return;
            sendToZoom('/zoom/userName/makeCoHost', name);
        });
    }

    // Issue Warning if a user name is associated with multiple ZoomID's
    // FIXME:  Most of these are due to ZoomOSC not issuing an offline message
    state.names
        .forEach((memberZoomIDs, Name) => {
            const members = state.names.get(Name);
            if (!members) {
                sendMessageToHosts(`Error: User "${Name}" no longer exists`);
                return;
            }
            if (members.length > 1) {
                sendMessageToHosts(`Warning: User "${Name}" is associated with more than one ZoomID.`);

                // Display groups that this Name is a member of
                members.forEach(member => {
                    state.groups.forEach((groupMemberZoomIDs, groupName) => {
                        const groupmembers = state.groups.get(groupName);
                        if (groupmembers.includes(member)) {
                            sendMessageToHosts(`Warning: User "${Name}" (${member}) is a member of group "${groupName}"`);
                        }
                    })
                })
            }
        })

    // FIXME: ZoomOSC doesn't send offline messages. Check if a member is no longer part of the meeting
    let personToRemove: PersonState;
    let memberOfGroup = false;
    state.everyone.forEach(person => {
        if (!person) return;

        // Issue a warning if the visited flag has not been set since the last iteration.
        if (!person.visited) {
            const Name = person.userName;

            // Display groups that this person is a member of
            state.groups.forEach((groupMemberZoomIDs, groupName) => {
                const groupmembers = state.groups.get(groupName);
                if (groupmembers.includes(person.zoomID)) {
                    sendMessageToHosts(`Warning: User "${Name}" (${person.zoomID}) is no longer online and was a member of group "${groupName}"\nUse /cu "${Name}" command to manually clear the user.`);
                    memberOfGroup = true;
                } else {
                    // Since member is not part of a group it is safe to remove them 
                    personToRemove = person;
                }
            })
        }

        // Get ready for the next iteration
        person.visited = false;
        state.everyone.set(person.zoomID, person);
    })

    // If the member is not part of a group remove them from the state.
    if (!memberOfGroup && personToRemove) {
        // FIXME: 
        // sendMessageToHosts(`Warning: Removing Member "${personToRemove.userName}" (${personToRemove.zoomID}) from the state.`);
        state.everyone.delete(personToRemove.zoomID);
        state.names.delete(personToRemove.userName);
    }
    // Send a list command to identify the online members
    silentlySendToZoom('/zoom/list');

    // check again after the specified poll time
    setTimeout(checkForUpdates, CONFIG_POLL_TIME);
}

function sendToZoom(message: string, ...args: any[]) {
    sendMessage(null,`Sending to Zoom: ${message} ${args}`);
    try {
        osc.send(new OSC.Message(message, ...args));
    } catch (e) {
        console.error("Failed to sendToZoom", e);
    }
}

function silentlySendToZoom(message: string, ...args: any[]) {
    try {
        osc.send(new OSC.Message(message, ...args));
    } catch (e) {
        console.error("Failed to sendToZoom", e);
    }
}


function sendMessage(recipientZoomID: number, message: string, ...args: any[]) {
    const today = getNow().toLocaleString().substring(0, 19)
        .replace(/T/g, " ");

    console.log(today, message, ...args);

    if (!recipientZoomID) return;

    sendToZoom('/zoom/zoomID/chat', recipientZoomID, message, ...args);
}

function sendMessageToHosts(message: string, ...args: any[]) {

    const today = getNow().toLocaleString().substring(0, 19)
        .replace(/T/g, " ");

    console.log(today, message, ...args);

    state.everyone.forEach(person => {
        const zoomid = person.zoomID;
    
        if (ZoomOSCInfo.isPro && isHost(zoomid)) {
            // sendMessage(zoomid, message, ...args);
            silentlySendToZoom('/zoom/zoomID/chat', zoomid, message, ...args);
        }
    });

    // FIXME: Replace above code 
    // state.everyone.filter(person => {...  return (ZoomOSCInfo.isPro && isHost(person.zoomID) ) })
    //     .forEach(person => { sendMessage(...) });
}

/**
 * Take a raw messages and turn it into an element we can easily deal with later
 * @param message the raw message from ZoomOSC
 */
function parseZoomOSCMessage(message: any): ZoomOSCMessage {
    const [address, targetID, userName, galIndex, zoomID, params] =
        [message.address, message.args[0], message.args[1], message.args[2], message.args[3], message.args.slice(4)];
    const [targetCount, listCount, userRole, onlineStatus, videoStatus, audioStatus, handRaised] =
        [message.args[4], message.args[5], message.args[6], message.args[7], message.args[8], message.args[9], message.args[10]];
    const [pingArg, zoomOSCversion, subscribeMode, galTrackMode, callStatus, numTargets, numUsers, isPro] =
        [message.args[1], message.args[2], message.args[3], message.args.slice(4), message.args[5], message.args[6], message.args[7], message.args[8]];

    return {
        rawZoomMessage: message,
        address: address,

        // Basic message format
        targetID: Number(targetID),
        userName: userName,
        galIndex: Number(galIndex),
        zoomID: Number(zoomID),
        params: params,

        // List message format
        targetCount: Number(targetCount),
        listCount: Number(listCount),
        userRole: Number(userRole),
        onlineStatus: Boolean(onlineStatus),
        videoStatus: Boolean(videoStatus),
        audioStatus: Boolean(audioStatus),
        handRaised: Boolean(handRaised),

        // Pong message format
        pingArg: pingArg,
        zoomOSCversion: String(zoomOSCversion),
        subscribeMode: Number(subscribeMode),
        galTrackMode: Number(galTrackMode),
        callStatus: Number(callStatus),
        numTargets: Number(numTargets),
        numUsers: Number(numUsers),
        isPro: Boolean(isPro)
    }
}

/**
 * Received a chat messages. Do something with it. If it starts with '/', then do something with it
 * @param message the message received
 */

function handleChatMessage(message: ZoomOSCMessage) {

    // console.log("DEBUG: handleChatMessage message", message);

    const chatMessage = message.params[0];
    if (chatMessage.charAt(0) !== '/') return;

    // clean the quotes before moving on
    cleanCurlyQuotes(chatMessage)

        // split each of the lines into an array item
        .split('\n')

        // send each of the lines as separate commands
        .forEach(chatLine => {
            const subMessage: ZoomOSCMessage = { ...message, params: chatLine.trim() };
            handleChatCommand(subMessage);
        })
}

function handleChatCommand(message: ZoomOSCMessage) {
    const chatMessage = message.params;

    // only deal with chat messages starting with slash, else exit
    if (!chatMessage[0].startsWith('/')) {
        return;
    }

    // console.log("DEBUG: handleChatCommand message", message);

    const params = wordify(chatMessage);
    // Process special commands
    if (processSpecial(message, params)) return;

    // only deal with chat messages from a host, else exit
    if (!isHost(message.zoomID)) {
        sendMessage(message.zoomID, "Error: Only the Host and Co-hosts can issue Chat Commands");
        return;
    }

    // slash-command, do something with it
    switch (params[0]) {
        case '/mx':  // mute all except members of group - No option => use LS_SUPPORT_GRP
            if (!primaryMode) return;
            muteAllExceptGroup(message.zoomID, params);
            break;
        case '/ux': // unmute all except members of group - No option => unmute all with video on
            if (!primaryMode) return;
            unmuteAllExceptGroup(message.zoomID, params);
            break;
        case '/ma': // mute all
            if (!primaryMode) return;
            sendToZoom('/zoom/all/mute');
            break;
        case '/m':  // mute group
        case '/mute':
            if (!primaryMode) return;
            muteGroup(message, params);
            break;
        case '/u':  // unmute group
        case '/unmute':
            if (!primaryMode) return;
            unmuteGroup(message, params);
            break;
        case '/g':
        case '/grp':
        case '/grps':
        case '/group': // create or list groups
            if (!primaryMode) return;
            manageGroups(message.zoomID, params);
            break;
        case '/p':
        case '/pin': // pin to second monitors (Must have a group called "ls-support")
            if (!primaryMode) return;
            setPin(message.zoomID, params);
            break;
        case '/mp':
        case '/mpin':     // multipin to monitor (Must have a group called "ls-support")
        case '/multipin': // Can only multipin to a device running ZoomOSC PRO
            if (!primaryMode) return;
            setMultiPin(message.zoomID, params);
            break;
        case '/names':    // Display the current list of users
            displayAllNames(message.zoomID);
            break;
        case '/list':     // initiate a /list command
            if (!primaryMode) return;
            sendToZoom('/zoom/list');
            break;
        case '/kr':
        case '/keeprunning':
            if (!primaryMode) return;
            if (checkPassword(message.zoomID, params.slice(2))) {
                 keepRunning(message.zoomID, params);
            }
            break;
        case '/cu':
        case '/clearuser':
            clearUser(message.zoomID, params);
            break;
        case '/xremote':
            executeRemote(message, params);
            break;
        case '/test':
            // console.log("quicktest host", params[1]);
            // sendToZoom('/zoom/list');
            break;
        case '/reset':
            // FIXME: This will not work on the secondary until we support passing the codeword from the primary to the secondary
            if (checkPassword(message.zoomID, params.slice(1))) {
                state.names.clear();
                state.groups.clear();
                state.everyone.clear();
                sendToZoom('/zoom/list');
            }
            break;
        case '/end':
            if (!primaryMode) return;
            if (checkPassword(message.zoomID, params.slice(1))) {
                 if (!ZoomOSCInfo.isPro) {
                     sendMessage(null, "Error: Unable to stop meeting - Must be running ZoomOSC Pro");
                 }
                 sendToZoom("/zoom/endMeeting");
             }
            break;
        default:
            sendMessage(message.zoomID, "Error: Unimplemented Chat Command");
    }
}

function processSpecial(message: ZoomOSCMessage, params: string[]): boolean {
    let specialCommand = true;
    const recipientZoomID = message.zoomID;

    switch (params[0]) {
        // These special commands can be executed on the Primary and Secondary
        case '/state':   // Display full state on console
            reportZoomOSCInfo();
            sendMessage(null, `Current Meeting:`, gCurrentMeetingConfig);
            sendMessage(null, `\n state:`, state);
            break;
        case '/xlocal':               // FIXME: This command should be protected with a passcode
            executeLocal(message, params);
            break;

        // These special commands can only be executed on the Primary
        case '/cohost':
            if (!primaryMode) return (specialCommand);
            if (checkPassword(recipientZoomID, params.slice(2))) {
                //check if person exists
                const personExists = getPeopleFromName(params[1]);
                if (!personExists) {
                    sendMessage(recipientZoomID, `processSpecial: Error - User "${params[1]}" does not exist`);
                } else {
                    sendToZoom('/zoom/userName/makeCoHost', params[1]);
                }
            }
            break;
        case '/whoami':
            if (!primaryMode) return (specialCommand);
            sendMessage(recipientZoomID, `Whoami: ${message.userName} ${message.zoomID}`);
            sendToZoom('/zoom/zoomID/chat', recipientZoomID, `/xlocal "${message.userName}" -whoami ${JSON.stringify(message.rawZoomMessage)}`);

            // Add User to ZoomOSCDevices
            createGroup(recipientZoomID, ["/grp", "-add", ZOOMOSC_DEVICES_GRP, message.userName], ADDTOGRP);
            break;

        // This special command can only be executed on the Seconday
        case '/primaryrestarted':
            if (primaryMode) return (specialCommand);
            // This was sent out to everyone in desperation. 
            // I know whoami, but the Primary no longer knows I exist as a secondary
            // FIXME: ZoomOSC is not sending offline messages when users leave the meeting. Clear the state for now. 
            state.names.clear();
            state.groups.clear();
            state.everyone.clear();
            sendToZoom('/zoom/userName/chat', PRIMARY_USER, `/whoami`);
            break;

        default:
            specialCommand = false;
    }
    return (specialCommand);
}

function checkPassword(recipientZoomID: number, params: string[]): boolean {
    let passwordValid = false;
    console.log()
    if (!gCurrentMeetingConfig && !gDefaultCodeWord) {

        sendMessage(recipientZoomID, `Error - This meeting is not configured with a codeword`);
        return (passwordValid);
    }

    if (!params[0]) {
        sendMessage(recipientZoomID, `Error - Codeword required for this command`);
        return (passwordValid);
    }

    if (( gCurrentMeetingConfig && (params[0] !== gCurrentMeetingConfig.codeWord)) ||
        (!gCurrentMeetingConfig && (params[0] !== gDefaultCodeWord)) ) {
        sendMessage(recipientZoomID, `Error - Invalid Codeword`);
        return (passwordValid);
    }
    passwordValid = true;
    return (passwordValid);
}

function isHost(zoomid: number): boolean {
    const person = state.everyone.get(zoomid);
    if (!person) return undefined;
    // console.log("handleisHost person", person);
    return (person.userRole == USERROLE_HOST) || (person.userRole == USERROLE_COHOST);
}

function getPeopleFromName(name: string): PersonState[] {
    const ids = state.names.get(name);
    if (!ids) return undefined;
    // return all the people with that name
    return ids.map(id => state.everyone.get(id));
}

function createGroup(recipientZoomID: number, params: string[], addtogroup: boolean) {

    let zoomidList: number[] = [];
    let namesList = params.slice(2);
    let groupName = params[1];

    if (addtogroup && params[2]) {
        zoomidList = state.groups.get(params[2]) ? state.groups.get(params[2]) : [];
        namesList = params.slice(3);
        groupName = params[2];

        // Check if this user is already in the group
        // FIXME: This currently only works for one name being added - Should be able to modify the code below with a filter
        const people = getPeopleFromName(params[3]);
        if (people) {
            if (zoomidList.indexOf(people[0].zoomID) > -1) return;
        }
    }

    namesList.forEach((name) => {
        const curUser: PersonState[] = getPeopleFromName(name);
        if (!curUser) {
            if (name === SKIP_PC_STRING) {
                zoomidList.push(SKIP_PC);
            } else {
                sendMessage(recipientZoomID, `createGroup: Error - User "${ name }" does not exist`);
            }
        } else {
            zoomidList.push(...curUser.map(user => user.zoomID));
        }
    });

    state.groups.set(groupName, zoomidList);

    // Update the state on all secondary PC's
    if ( groupName == ZOOMOSC_DEVICES_GRP) {
        silentlySendToZoom('/zoom/list');
    }
}

function deleteGroup(recipientZoomID: number, param: string) {
    const members = state.groups.get(param);

    if (!members) {
        sendMessage(recipientZoomID, `deleteGroup Error: Group "${ param }" does not exist`);
        return;
    }

    state.groups.delete(param);
}

function displayGroup(recipientZoomID: number, param: string) {
    const members = state.groups.get(param);

    if (!members) {
        sendMessage(recipientZoomID, `displayGroup Error: Group "${ param }" does not exist`);
        return;
    }

    // FIXME: For now - Added ": " prefix to response to so the Primary won't interpret the message as a command
    let buffer = ": /grp " + param;
    members.forEach((zoomid) => {
        if (zoomid == SKIP_PC) {
            buffer = buffer.concat(" " + SKIP_PC_STRING);
        } else {
            const person = state.everyone.get(zoomid);
            const name = person.userName;
            buffer = buffer.concat(" \"" + name + "\"");
        }
    });

    sendMessage(recipientZoomID, buffer);
}


function displayAllGroups(recipientZoomID: number) {
    state.groups
        .forEach((memberZoomIDs, groupName) => {
            displayGroup(recipientZoomID, groupName);
        })
}

function displayName(recipientZoomID: number, param: string) {
    const members = state.names.get(param);

    if (!members) {
        sendMessage(recipientZoomID, `displayName Error: Name "${ param }" does not exist`);
        return;
    }

    let buffer = "";
    members.forEach((zoomid) => {
        const person = state.everyone.get(zoomid);
        const name = person.userName;
        buffer = buffer.concat("\"" + name + "\"\n");
    });

    sendMessage(recipientZoomID, buffer);
}

function displayAllNames(recipientZoomID: number) {
    state.names
        .forEach((memberZoomIDs, Name) => {
            displayName(recipientZoomID, Name);
        })
}

function manageGroups(recipientZoomID: number, params: string[]) {

    // Usage:  /grp [(-l |-list) | (-la -listall) | (-d | -delete) | (-da | -deleteall] <groupname>
    //         /grp <groupname> [<group members>]

    // Sub commands
    if (params[1] && params[1].startsWith('-')) {
        switch (params[1]) {
            case '-l':
            case '-list':
                if (params[2]) {
                    displayGroup(recipientZoomID, params[2]);
                }
                break;
            case '-la':
            case '-listall':
                displayAllGroups(recipientZoomID);
                break;
            case '-d':
            case '-delete':
                if (params[2]) {
                    deleteGroup(recipientZoomID, params[2]);
                }
                break;
            case '-a':
            case '-add':
                if (params[2]) {
                    createGroup(recipientZoomID, params, ADDTOGRP);
                    displayGroup(recipientZoomID, params[2]);
                }
                break;
            case '-da':
            case '-deleteall':
                state.groups.clear();
                break;
            default:
                sendMessage(recipientZoomID, "Error: Unimplemented Groups Sub-Command");
        }
        return;
    }

    if (params.length > 2) {
        createGroup(recipientZoomID, params, null);
    } else {
        displayGroup(recipientZoomID, params[1]);
    }
}

function setPin(recipientZoomID: number, params: string[]) {
    const supportPCs = state.groups.get(LS_SUPPORT_GRP);
    const currentGroup = state.groups.get(params[1]);

    // Make sure LS-SUPPORT group exists
    if (!supportPCs) {
        sendMessage(recipientZoomID, `setPin Error: LS-SUPPORT Group "${ LS_SUPPORT_GRP }" does not exist`);
        return;
    }

    // Make sure group exists
    if (!currentGroup) {
        sendMessage(recipientZoomID, `setPin Error: Group "${ params[1] }" does not exist`);
        return;
    }

    let pos = -1;
    currentGroup.forEach(function (zoomid) {
        pos++;
        if (zoomid == SKIP_PC) return;

        const person = state.everyone.get(zoomid);
        const name = person.userName;
        const targetPC = state.everyone.get(supportPCs[pos]);
        if (targetPC.zoomID == SKIP_PC) return;

        if (!person) {
            sendMessage(recipientZoomID, `setPin: Error - User "${ person.zoomID }" does not exist`);
        } else {

            // console.log("DEBUG: targetPC.zoomID", targetPC.zoomID, myZoomID);

            // Check if I'm the target
            if (targetPC.zoomID == myZoomID) {
                // FIXME: Prefer to use zoomID instead of userName, but ZoomOSC doesn't appear to work properly
                //        For some reason, it works for multi-pinning
                sendToZoom("/zoom/userName/pin2", name);
                // FIXME: sendToZoom("/zoom/me/zoomID/pin2", zoomid);
            } else {
                // FIXME: Prefer to use zoomID instead of userName, but ZoomOSC doesn't appear to work properly
                sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal "${targetPC.zoomID}" /zoom/userName/pin2 "${name}"`);
                // FIXME: sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal "${targetPC.zoomID}" /zoom/me/zoomID/pin2 "${zoomid}"`);
            }
        }
    });
}

function setMultiPin(recipientZoomID: number, params: string[]) {
    const supportPCs = state.groups.get(LS_SUPPORT_GRP);
    const currentGroup = state.groups.get(params[1]);

    // FIXME: Need to implement default multipin device - Use primary device for now.
    //        This could/should change when there are more than one ZoomOSC PRO activations
    const multipinDevice = myName;

    // Make sure device exists
    const device = getPeopleFromName(multipinDevice);
    if (!device) {
        sendMessage(recipientZoomID, `setMultiPin Error: User "${ multipinDevice }" does not exist`);
        return;
    }
    // Make sure LS-SUPPORT group exists
    if (!supportPCs) {
        sendMessage(recipientZoomID, `setMultiPin Error: LS-SUPPORT Group "${ LS_SUPPORT_GRP }" does not exist`);
        return;
    }
    // Make sure device is in LS-SUPPORT group
    const gotit = supportPCs.filter(id => id == device[0].zoomID);
    if (gotit.length == 0) {
        sendMessage(recipientZoomID, `setMultiPin Error: Device: "${ multipinDevice }" is not included in Group: "${ LS_SUPPORT_GRP }"`);
        return;
    }
    // Make sure Multipin group exists
    if (!currentGroup) {
        sendMessage(recipientZoomID, `setMultiPin Error: Group "${ params[1] }" does not exist`);
        return;
    }

    const targetPC = state.everyone.get(device[0].zoomID);

    // Clear all Pins before adding new group
    if (targetPC.userName == myName) {
        sendMessage(null, `setMultiPin:`);
        sendToZoom("/zoom/me/clearPin");
    } else {
        // FIXME: Don't think we can ever get here. 
        sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal "${targetPC.zoomID }" /zoom/me/clearPin`);
    }

    currentGroup.forEach(function (zoomid) {
        if (zoomid == SKIP_PC) return;

        const person = state.everyone.get(zoomid);
        const name = person.userName;

        if (!person) {
            sendMessage(recipientZoomID, `setMultiPin: Error - User "${ person.zoomID }" does not exist`);
        } else {
            if (targetPC.userName == myName) {
                sendToZoom("/zoom/zoomID/addPin", zoomid);
            } else {
                // FIXME: Not sure if addPin works with a list of zoomID's
                //        Don't think we can ever get here.       
                sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal "${targetPC.zoomID}" /zoom/zoomID/addPin ${zoomid}`);
            }
        }
    });
}

function muteAllExceptGroup(recipientZoomID: number, params: string[]) {

    let group: string;

    if (!params[1]) {
        group = DEFAULT_MX_GRP;
    } else {
        group = params[1];
    }

    const grpmembers = state.groups.get(group);
    if (!grpmembers) {
        sendMessage(recipientZoomID, `muteAllExceptGroup: Group "${group}" does not exist - Muting all users`);
    }

    if (!state.groups.get(group)) {
        // no group available, mute everyone
        sendToZoom('/zoom/all/mute');
        return;
    }

    // Unmute the leaders then mute everyone else
    sendToZoom('/zoom/users/zoomID/unMute', ...state.groups.get(group));
    sendToZoom('/zoom/allExcept/zoomID/mute', ...state.groups.get(group));
}

function unmuteAllExceptGroup(recipientZoomID: number, params: string[]) {
    const group = params[1];

    sendMessage(null, `Unmute all except group: ${group}`);

    const groupmembers = state.groups.get(group);
    if (group && !groupmembers) {
        sendMessage(recipientZoomID, `unmuteAllExceptGroup: Group "${group}" does not exist - Unmuting all users with video on`);
    }

    state.everyone.forEach(person => {
        if (!person) return;

        if (group && groupmembers && groupmembers.includes(person.zoomID)) return;

        // Only unmute users that are muted
        // To mitigate unmuting people that granted unmute permission, but have their video off, don't unmute.  
        if (!person.audioOn && person.videoOn ) {
            silentlySendToZoom('/zoom/zoomID/unMute', person.zoomID);
        }
    })

}
function unmuteGroup(message: ZoomOSCMessage, params: string[]) {
    const curGroup = state.groups.get(params[1]);
    if (!curGroup) return;

    sendToZoom('/zoom/users/zoomID/unMute', ...state.groups.get(params[1]));
    // displayGroup(message.zoomID, params[1]);
}

function muteGroup(message: ZoomOSCMessage, params: string[]) {
    const curGroup = state.groups.get(params[1]);
    if (!curGroup) return;

    sendToZoom('/zoom/users/zoomID/mute', ...state.groups.get(params[1]));
    // displayGroup(message.zoomID, params[1]);
}

function executeRemote(message: ZoomOSCMessage, params: string[]) {
    const curUser: PersonState[] = getPeopleFromName(params[1]);
    if (!curUser) return;

    console.log(`executeRemote`);

    // FIXME: using the zoomID isn't working - use userName for now
    // sendToZoom('/zoom/zoomID/chat', curUser.map(user => user.zoomID), "/xlocal ", ...params.slice(2));
    sendToZoom('/zoom/userName/chat', curUser.map(user => user.userName), "/xlocal ", ...params.slice(2));
}

function executeLocal(message: ZoomOSCMessage, params: string[]) {

    // Command format: /xlocal targetPC.zoomID <ZoomOSC Command> [options]`);
    
    // Make sure this is the targetPC
    // FIXME: Figure out how to allow /execute local before we know whoami
    if (!primaryMode || (Number(params[1]) == myZoomID)) {

        // Sub-command to mirror the result of the /zoomosc/list command that was executed on the primary script
        //        /xlocal targetPC.zoomID -mirrorlist <original /list command>`);
        if (params[2] == "-mirrorlist") {

            // Only Mirror when in secondary mode
            if (primaryMode) return;

            // Create a ZoomOSC message from the information sent from the primary device
            const oscMsgString = message.rawZoomMessage.args[4];
            const newMessage = JSON.parse(oscMsgString.slice(oscMsgString.indexOf(params[2]) + params[2].length));;

            // Parse the forwarded /list message and update the local copy of state
            handleList(parseZoomOSCMessage(newMessage));
            
            return;
        }

        if (params[2] == "-whoami") {
            const oscMsgString = message.rawZoomMessage.args[4];
            const newMessage = JSON.parse(oscMsgString.slice(oscMsgString.indexOf(params[2]) + params[2].length));;

            const parsedMessage = parseZoomOSCMessage(newMessage);

            myName = parsedMessage.userName;
            myZoomID = parsedMessage.zoomID;

            return;
        }

        // FIXME: Not sure why this doesn't compile - Probably because the result of the slice could be null
        // sendToZoom(...params.slice(2));
        sendToZoom(params[2], ...params.slice(3));
        sendMessage(null, `executeLocal myName = "${myName}"`, params);
    }
}

function keepRunning(recipientZoomID: number, params: string[]) {
    const minutestoadd = (params[1] && gCurrentMeetingConfig) ? Number(params[1]) : DEFAULT_ADD_MINUTES;

    if (!gCurrentMeetingConfig) return;

    gCurrentMeetingConfig.maxEndDateTime = gCurrentMeetingConfig.maxEndDateTime.plusMinutes(minutestoadd);
    const newEndtime = gCurrentMeetingConfig.maxEndDateTime.format(DateTimeFormatter.ofPattern('hh:mm'));

    // Let the host and co-hosts know what the meeting end time is
    sendMessageToHosts(`New meeting endtime = "${newEndtime}"`);
}

// Remove an individual server from the state
// Don't change the groups, just mention that they should be updated. 
function clearUser(recipientZoomID: number, params: string[]) {
    const name = params[1];
    const zoomIDs: number[] = state.names.get(name);

    if (zoomIDs) {

        sendMessage(recipientZoomID, `Clearing User "${name}" (${zoomIDs})`);

        // Display groups that this person is a member of
        state.groups.forEach((groupMemberZoomIDs, groupName) => {
            const groupmembers = state.groups.get(groupName);
            if (groupmembers.includes(zoomIDs[0])) {
                sendMessage(recipientZoomID, `"${name}" (${zoomIDs}) is a member of group "${groupName}"\nGroup "${groupName}" should be reloaded`);
            }
        })

        state.everyone.delete(zoomIDs[0]);
        state.names.delete(name);
    }
}

// This changes curly quotes and strange line-endings to plain ascii versions
function cleanCurlyQuotes(str: string): string {
    return str &&
        String(str)
            .replace(/[\r]/g, "\n")
            .replace(/[\u2028]/g, "\n")
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"');
}

// This combines quotes strings into a single "word"
function wordify(str: string): string[] {
    // combine words in quotes to be a single param. eg: param1 "second param" 'third param'
    return str &&
        (String(str).match(/[^\s"]+|"([^"]*)"/gi) || [])
            .map((word) => word.replace(/^"(.+(?="$))"$/, '$1'));
}

function handleUnmute(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;
    person.audioOn = true;
    // console.log("DEBUG: handleUnmute message, person", message, person);
}

function handleMute(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;
    person.audioOn = false;
    // console.log("DEBUG: handleMute message, person", message, person);
}

function handleVideoOn(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;
    person.videoOn = true;
    // console.log("DEBUG: handleVideoOn message, person", message, person);
}

function handleVideoOff(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;
    person.videoOn = false;
    // console.log("DEBUG: handleVideoOff message, person", message, person);
}

function handleRoleChanged(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;
    person.userRole = Number(message.params[0]);

    // console.log("DEBUG: handleRoleChanged message, person", message, person);
}

function addZoomIDToName(name: string, zoomID: number) {
    const zoomIDs: number[] = state.names.get(name);
    if (!zoomIDs) {
        state.names.set(name, [zoomID]);
        return;
    }

    // if it's already there, we're done
    if (zoomIDs.includes(zoomID)) return;

    state.names.set(name, [...zoomIDs, zoomID]);
}

function removeZoomIDFromName(name: string, zoomID: number) {
    const zoomIDs: number[] = state.names.get(name);
    // no zoom ids found, return
    if (!zoomIDs) return;

    // example of how to call a function inside a filter
    // const newZoomIDs = zoomIDs.filter((id) => {
    //     console.log(`does ${ id } == ${ zoomID }?`)
    //    return id !== zoomID;
    // });
    // FIXME: shortcut
    const newZoomIDs = zoomIDs.filter(id => id !== zoomID);

    if (newZoomIDs.length === 0) {
        // nothing left, remove the whole thing
        state.names.delete(name);
        return;
    }

    state.names.set(name, newZoomIDs);
}

function handleNameChanged(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;

    // update the names table
    removeZoomIDFromName(person.userName, message.zoomID);
    addZoomIDToName(message.userName, message.zoomID);
    sendMessage(null,`handleuserNameChanged zoomID: ${ message.zoomID }, oldName: ${ person.userName }, newName: ${ message.userName }`);

    person.userName = message.userName;

    // Check if myName needs to be updated
    if (message.zoomID == myZoomID) {
        myName = message.userName;
    }

    // console.log("DEBUG: NameChanged message, person", message, person);
}

function handleOnline(message: ZoomOSCMessage) {
    let person: PersonState = state.everyone.get(message.zoomID);

    if (person) return;

    person = {
        zoomID: message.zoomID,
        userName: message.userName,
        userRole: USERROLE_NONE,
        onlineStatus: true,
        videoOn: false,
        audioOn: false,
        visited: true
    }
    state.everyone.set(person.zoomID, person);
    addZoomIDToName(message.userName, message.zoomID);

    // Figure out whoami - This works for both primary and secondary, script must be running before meeting starts
    //                     In secondary, role will not be updated until after the first /list command mirrors the full state
    if (message.address == "/zoomosc/me/online") {
        myName = message.userName;
        myZoomID = message.zoomID;
    }

    // FIXME: ZoomOSC doesn't support "Mute Participants upon Entry"
    //        For now, manually mute people upon entry after specified number of people have joined the meeting
    if (gCurrentMeetingConfig && state.names.size > Number(gCurrentMeetingConfig.muteUponEntry)) {
        sendToZoom('/zoom/zoomID/mute', person.zoomID);
    }

    // FIXME: ZoomOSC is not issuing a /list after a member joins.
    //        For now issue a /list command each time someone joins the meeting
    silentlySendToZoom('/zoom/list');

    // console.log("DEBUG: handleOnline message, person", message, person, myName, myZoomID );
}

// FIXME: ZoomOSC is not issuing the offline command yet
function handleOffline(message: ZoomOSCMessage) {
    let person: PersonState = state.everyone.get(message.zoomID);

    if (person) return;

    sendMessage(null,"handleOffline message, person", message, person);
    state.everyone.delete(person.zoomID);
    removeZoomIDFromName(message.userName, message.zoomID);

    // console.log("DEBUG: handleOffline message, person", message, person);

}

function handleList(message: ZoomOSCMessage) {

    let person: PersonState = state.everyone.get(message.zoomID);
    if (!person) {
        person = {
            zoomID: message.zoomID,
            userName: message.userName,
            userRole: message.userRole,
            onlineStatus: message.onlineStatus,
            videoOn: message.videoStatus,
            audioOn: message.audioStatus,
            visited: true
        }
        state.everyone.set(person.zoomID, person);
    } else {
        person.userName = message.userName;
        person.userRole = message.userRole;
        person.onlineStatus = message.onlineStatus;
        person.videoOn = message.videoStatus;
        person.audioOn = message.audioStatus;
        person.visited = true;
    }
    addZoomIDToName(message.userName, message.zoomID);

    // If the user is offline, remove from state
    if (!person.onlineStatus) {
        console.log("remove user", person.zoomID)
        state.everyone.delete(person.zoomID);
        removeZoomIDFromName(person.userName, person.zoomID);
    }

    // Figure out whoami - This works for the primary device
    if (primaryMode && (message.address == "/zoomosc/me/list")) {
        myName = message.userName;
        myZoomID = message.zoomID;
    }

    // console.log("DEBUG: handleList message, person", message, person, myName, myZoomID);

    // Send an /xlocal -mirror list command to all members of the ZOOMOSC_DEVICES group
    const ZoomOSCDevices = state.groups.get(ZOOMOSC_DEVICES_GRP);

    if (!primaryMode || !ZoomOSCDevices) return;

    ZoomOSCDevices.forEach((zoomid) => {
        const targetPC = state.everyone.get(zoomid);
        // Make sure the user in the ZoomOSCDevices group is still listed in the state
        if (!targetPC) return;
        silentlySendToZoom('/zoom/zoomID/chat', zoomid, `/xlocal "${targetPC.userName}" -mirrorlist ${JSON.stringify(message.rawZoomMessage)}`);
    });
}

async function handleMeetingStatus(message: ZoomOSCMessage) {
    state.names.clear();
    state.groups.clear();
    state.everyone.clear();
    myName = null;
    myZoomID = null;

    sendMessage(null, "handleMeetingStatus", message.targetID);

    // See if anything changes with ZoomOSC
    sendToZoom('/zoom/ping', "ZoomOSC Information");
    await sleep(2000);

    // When meeting starts - Try to figure out whoami
    // Note: Normal message parameters don't apply here, use the first parameter.
    if (Number(message.targetID) == 1) {
        await getWhoami();
    }
}

function handlePongReply(message: ZoomOSCMessage) {

    ZoomOSCInfo = {
        pingArg: message.pingArg,
        zoomOSCversion: message.zoomOSCversion,
        subscribeMode: message.subscribeMode,
        galTrackMode: message.galTrackMode,
        callStatus: message.callStatus,
        numTargets: message.numTargets,
        numUsers: message.numUsers,
        isPro: message.isPro
    }

    console.log("handlePongReply: ZoomOSC Information", ZoomOSCInfo);
}

function setupOscListeners() {

    // convenient code to print every incoming messagse
    // osc.on('*', message => {
    //   console.log("OSC * Message", message)
    // });

    osc.on('/zoomosc/meetingStatus', async message => handleMeetingStatus(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/pong', async message => handlePongReply(parseZoomOSCMessage(message)));

    osc.on('/zoomosc/user/chat', async message => handleChatMessage(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/unMute', async message => handleUnmute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/mute', async message => handleMute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/videoOn', async message => handleVideoOn(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/videoOff', async message => handleVideoOff(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/roleChanged', async message => handleRoleChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/userNameChanged', async message => handleNameChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/online', async message => handleOnline(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/offline', async message => handleOffline(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/list', async message => handleList(parseZoomOSCMessage(message)));

    osc.on('/zoomosc/me/chat', async message => handleChatMessage(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/unMute', async message => handleUnmute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/mute', async message => handleMute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/videoOn', async message => handleVideoOn(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/videoOff', async message => handleVideoOff(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/roleChanged', async message => handleRoleChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/userNameChanged', async message => handleNameChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/online', async message => handleOnline(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/offline', async message => handleOffline(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/list', async message => handleList(parseZoomOSCMessage(message)));
}

// not used right now, but could be used to pause between things
// noinspection JSUnusedLocalSymbols
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
