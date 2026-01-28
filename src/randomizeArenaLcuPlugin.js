import LcuPlugin from 'lcu-plugin';
import axios from 'axios';

const CURRENT_SUMMONER_ENDPOINT = 'lol-summoner/v1/current-summoner';
const LOBBY_ENDPOINT = 'lol-lobby/v2/lobby';
const SUMMONER_ENDPOINT = 'lol-summoner/v2/summoners/puuid/';

const SUBTEAM_UPDATE_ENDPOINT = 'lol-lobby/v2/lobby/subteamData';
const CONVERSATIONS_EVENT = 'OnJsonApiEvent_lol-chat_v1_conversations';

const TEAMS_LIST_HEADER = '⠀\nArena Teams';
const MESSAGE_RETRY_PERIOD = 200;
const NOT_SELF_MIN_DELAY = 750; // ms
const DOUBLE_UP_QUEUES = new Set([1160]);

export default class RandomizeArenaLcuPlugin extends LcuPlugin {
  constructor(alwaysNewTeams = false) {
    super();
    this.alwaysNewTeams = alwaysNewTeams;
  }

  onConnect(clientData) {
    axios.defaults.baseURL = `${clientData.protocol}://${clientData.address}:${clientData.port}`;
    axios.defaults.auth = { username: clientData.username, password: clientData.password };

    return this.createPromise((resolve, reject) => {
      this.getCurrentSummoner().then((summonerUsername) => {
        this.subscribeEvent(CONVERSATIONS_EVENT, this.handleLobbyChat(summonerUsername));
        this.log('is ready');
        resolve();
      }).catch((error) => {
        reject(error);
      });
    });
  }

  getCurrentSummoner(retriesLeft = 20) {
    return this.createPromise((resolve, reject) => {
      this.getCurrentSummonerHelper(retriesLeft, resolve, reject);
    });
  }

  getCurrentSummonerHelper(retriesLeft, resolve, reject) {
    axios.get(CURRENT_SUMMONER_ENDPOINT).then((resp) => {
      resolve(`${resp.data.gameName}#${resp.data.tagLine}`);
    }).catch((error) => {
      if ((error.code !== 'ECONNREFUSED' && error?.response?.status >= 500) || retriesLeft <= 0) {
        this.log('error in getting current summoner', error);
        reject(error);
      }
      setTimeout(() => {
        this.getCurrentSummonerHelper(retriesLeft - 1, resolve, reject);
      }, 1000);
    });
  }

  sendMessage(chatUrl, message, retriesLeft = 2) {
    axios.post(chatUrl, {
      body: message,
    }).catch((error) => {
      if (retriesLeft > 0) {
        this.log(`send message error, retrying (${retriesLeft - 1} retries left)`);
        setTimeout(this.sendMessage, MESSAGE_RETRY_PERIOD, chatUrl, message, retriesLeft - 1);
      } else {
        this.error('error: ', error);
      }
    });
  }

  async getSummonerInfo(puuid) {
    return axios.get(SUMMONER_ENDPOINT + puuid).catch((error) => {
      this.error('error: ', error);
    });
  }

  async getLobby() {
    return axios.get(LOBBY_ENDPOINT).catch((e) => {
      this.error('error getting lobby', e);
    }).then((resp) => Promise.all(resp.data.members.map((player) => this.getSummonerInfo(player.puuid)))
      .then((resps) => {
        const nameMap = resps.reduce((map, resp) => {
          map[resp.data.puuid] = `${resp.data.gameName}#${resp.data.tagLine}`;
          return map;
        }, {});
        for (const member of resp.data.members) {
          member.summonerName = nameMap[member.puuid];
        }
        return resp;
      }));
  }

  async moveTeams(teamNumber, slot) {
    return axios.put(SUBTEAM_UPDATE_ENDPOINT, {
      intraSubteamPosition: slot,
      subteamIndex: teamNumber,
    }).catch((error) => {
      this.error('error moving teams', error);
    });
  }

  handleLobbyChat(currentSummonerUsername) {
    return async (event) => {
      if (event.eventType !== 'Create') {
        return;
      }
      if (event.data.type !== 'groupchat') {
        return;
      }

      if (!/(^\/rand team[s]?$)/i.test(event.data.body)) {
        return;
      }

      // check if arena
      const lobby = await this.getLobby();
      if (lobby.data.gameConfig.maxLobbySize !== 16 && DOUBLE_UP_QUEUES.has(lobby.data.gameConfig.queueId)) {
        this.log('not arena or double up, ignoring');
        return;
      }

      const [players, teams] = await this.calcTeams(lobby);

      const chatUrl = event.uri.substring(0, event.uri.lastIndexOf('/'));
      await this.listTeams(chatUrl, teams);

      const swaps = this.calcSwaps(currentSummonerUsername, players);

      await this.executeSwaps(swaps);
    };
  }

  async calcTeams(lobby) {
    const players = {};
    const slots = {};
    for (const player of lobby.data.members) {
      players[player.summonerName] = { current: [player.subteamIndex, player.intraSubteamPosition, null] };
      slots[[player.subteamIndex, 3 - player.intraSubteamPosition]] = player.summonerName;
    }

    for (const player of lobby.data.members) {
      players[player.summonerName].current[2] = slots[[player.subteamIndex, player.intraSubteamPosition]] || null;
    }

    // TODO check if the teams are all the same and then randomize again if so if bool is set
    const usernames = this.shuffleArray(lobby.data.members.map((player) => player.summonerName));
    const teams = [];
    for (let i = 0; i < usernames.length; i += 2) {
      const p1 = usernames[i];
      const p2 = usernames[i + 1] || null;
      const team = [p1];
      players[p1].new = p2;
      if (p2) {
        team.push(p2);
        players[p2].new = p1;
      }
      teams.push(team);
    }

    return [players, teams];
  }

  // https://stackoverflow.com/a/12646864/7148414
  /* Randomize array in-place using Durstenfeld shuffle algorithm */
  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  // Multi posts after a delay if a non plugin user uses it (chat has too big latency to ensure that only 1 message gets printed (~425 ms to detect
  // message sent))
  async listTeams(chatUrl, teams) {
    const teamMessages = teams.map((usernames, i) => `${i + 1}: ${usernames.join(' & ')}`);

    const readyStatusStr = [`${TEAMS_LIST_HEADER}:`].concat(teamMessages).join('\n');
    await this.sendMessage(chatUrl, readyStatusStr);
  }

  calcSwaps(currentSummonerUsername, players) {
    const swaps = [];

    while (swaps.length < 20 && this.stillNeedSwaps(players)) {
      if (players[currentSummonerUsername].current[2] === players[currentSummonerUsername].new) {
        const [newPartner, { current: firstSwap }] = Object.entries(players).find(([username, { current: [_, __, currentPartner], new: newPartner }]) => currentPartner !== newPartner);
        swaps.push(this.swapTo(players, currentSummonerUsername, newPartner));
      }

      swaps.push(this.swap(players, currentSummonerUsername));
    }

    return swaps;
  }

  stillNeedSwaps(players) {
    for (const { current: [_, __, currentPartner], new: newPartner } of Object.values(players)) {
      if (currentPartner !== newPartner) {
        return true;
      }
    }
    return false;
  }

  swap(players, currentSummonerUsername) {
    const currentPartner = players[currentSummonerUsername].current[2];
    const newPartner = currentPartner !== null ? players[currentPartner].new
      : (Object.entries(players).find(([_, { new: newPartner }]) => newPartner === null)
        || Object.entries(players).find(
          ([username, { current: [_, __, partner], new: newPartner }]) => partner === null && username !== currentSummonerUsername && newPartner
            !== currentSummonerUsername,
        )
        || Object.entries(players).find(([_, { new: newPartner }]) => currentSummonerUsername === newPartner)
      )[0];
    return this.swapTo(players, currentSummonerUsername, newPartner);
  }

  swapTo(players, currentSummonerUsername, newPartner) {
    let marker = false;
    const currentPartner = players[currentSummonerUsername].current[2];
    const newSwap = newPartner ? players[newPartner].current
      : Object.entries(players).find(([_, { current: [__, ___, partner] }]) => partner === null)[1].current;
    if (currentPartner === null && newSwap[2] === null) {
      players[currentSummonerUsername].current = [...newSwap];
      newSwap[1] = 3 - newSwap[1];
      newSwap[2] = newPartner;
    }
    if (newPartner === null) {
      newPartner = Object.entries(players).find(([_, { current: [__, ___, partner] }]) => partner === null)[0];
      players[currentSummonerUsername].current = [...newSwap];
      newSwap[1] = 3 - newSwap[1];
      newSwap[2] = newPartner;
      marker = true;
    }
    const swap = [newSwap[0], newSwap[1]];
    if (newPartner !== null) {
      players[newPartner].current = players[currentSummonerUsername].current;
    }
    players[currentSummonerUsername].current = newSwap;
    if (currentPartner !== null) {
      players[currentPartner].current[2] = marker ? null : newPartner;
    }
    if (newSwap[2] !== null) {
      players[newSwap[2]].current[2] = currentSummonerUsername;
    }
    return swap;
  }

  async executeSwaps(swaps) {
    for (const [teamNumber, slot] of swaps) {
      await this.moveTeams(teamNumber, slot);
    }
  }
}
