import { proxy } from 'valtio'
import { subscribeKey } from 'valtio/utils'
import api from './api'

import { STORE_PROPS, TOP_NEW_ID, PLAY_MODE } from '../constants'
// 剪裁图片
const IMAGE_CLIP = '?param=150y150'
// store 中不需要存储的键
const OMIT_PERSIST_KEYS = ['playlistGroup', 'audioState', 'errorMessage', 'playing']

// 播放器
let audio

const store = proxy({
  cookies: null,
  ...STORE_PROPS,
  syncPersistData () {
    return new Promise((resolve) => {
      chrome.storage.sync.get(persistData => {
        if (persistData) {
          if (persistData.cookies) {
            api.setCookie(persistData.cookies)
          }
          Object.assign(store, persistData)
        }
        resolve(store)
      })
    })
  },
  updateAudioTime (currentTime) {
    if (audio) {
      audio.currentTime = currentTime
    }
    store.applyChange({ audioState: { ...store.audioState, currentTime } })
    if (!store.playing) {
      return store.togglePlaying()
    }
  },
  togglePlaying () {
    const { playing } = store
    if (playing) {
      audio.pause()
    } else {
      audio.play()
    }
    return store.applyChange({ playing: !playing })
  },
  updateVolume (volume) {
    audio.volume = volume
    return store.applyChange({ volume })
  },
  async playPrev () {
    const { playlist, songId } = getPlaylistBySongId()
    const song = await getSong(playlist, store.playMode, songId, -1)
    return store.applyChange({ song })
  },
  async playNext () {
    const { playlist, songId } = getPlaylistBySongId()
    const song = await getSong(playlist, store.playMode, songId)
    return store.applyChange({ song })
  },
  async updatePlayMode () {
    const modeKeys = Object.keys(PLAY_MODE)
    const modeKeyIndex = modeKeys.findIndex(key => PLAY_MODE[key] === store.playMode)
    const nextModeKeyIndex = (modeKeyIndex + 1 + modeKeys.length) % modeKeys.length
    const playMode = PLAY_MODE[modeKeys[nextModeKeyIndex]]
    return store.applyChange({ playMode })
  },
  async changePlaylist (playlistId) {
    const song = await loadSongWhenPlaylistChanged()
    return store.applyChange({
      selectedPlaylistId: playlistId,
      song
    })
  },
  async likeSong () {
    const { song } = store
    if (!song) throw new Error('无选中歌曲')
    const res = await api.likeSong(song.id, true)
    if (res.code === 200) {
      const playlistGroup = await updateLikeSongsPlaylist()
      return store.applyChange({ playlistGroup, message: '收藏成功' })
    } else {
      throw new Error('收藏到我喜欢的音乐失败')
    }
  },
  async login (phone, password) {
    const res = await api.cellphoneLogin(phone, password)
    if (res.code === 200) {
      const { userId } = res.profile
      return store.applyChange({ userId })
    } else {
      throw new Error(res.msg)
    }
  },
  async loadPlaylists () {
    const playlists = await loadAllPlaylists()
    return store.applyChange({
      playlistGroup: [...store.playlistGroup, ...playlists]
    })
  },
  // 获取新歌榜
  async fetchTopNew () {
    const res = await api.getPlaylistDetail(TOP_NEW_ID)
    if (res.code === 200) {
      const playlist = tidyPlaylist(res.playlist)
      return store.applyChange({
        playlistGroup: [playlist, ...store.playlistGroup.slice(1)]
      })
    } else {
      throw new Error('获取新歌榜失败')
    }
  },
  popupInit () {
    return store
  },
  logout () {
    audio.pause()
    api.clearCookie()
    store.applyChange({
      playing: false,
      cookies: '',
      userId: null,
      playlistGroup: []
    })
    store.bootstrap()
  },

  applyChange (change) {
    persist(change)
    Object.assign(store, change)
    return change
  },

  async bootstrap () {
    await store.syncPersistData()
    await store.fetchTopNew()
    if (!store.cookies) {
      await store.changePlaylist(store.playlistGroup[0].id)
    }
    if (store.userId) {
      const res = await api.loginRefresh()
      if (res.code === 200) {
        await loadAllPlaylists()
      } else if (res.code === 301) { // cookie 失效
        store.applyChange({
          userId: null,
          cookies: null,
          selectedPlaylistId: TOP_NEW_ID
        })
      }
    }
  },
  setCookie (cookies) {
    chrome.storage.sync.set({ cookies })
    api.setCookie(cookies)
    return store.applyChange({ cookies })
  }
})

function tidyPlaylist (playlist) {
  const { id, creator: { nickname: creator }, name, coverImgUrl, tracks } = playlist
  const { songsIndex: normalSongsIndex, songsHash } = tracksToSongs(tracks)
  const shuffleSongsIndex = shuffleArray(normalSongsIndex)
  return { id: Number(id), creator, name, songsCount: normalSongsIndex.length, coverImgUrl: coverImgUrl + IMAGE_CLIP, songsHash, normalSongsIndex, shuffleSongsIndex }
}

function tracksToSongs (tracks) {
  const songs = tracks.map(track => {
    const { id, name, al: { picUrl }, ar } = track
    return { id, name, picUrl: picUrl + IMAGE_CLIP, artists: compactArtists(ar) }
  })
  const songsHash = songs.reduce((songsHash, song) => {
    songsHash[song.id] = song
    return songsHash
  }, {})
  const songsIndex = songs.map(song => song.id)
  return { songsIndex, songsHash }
}

function compactArtists (artists) {
  return artists.map(artist => artist.name).join('/')
}

function getSong (playlist, playMode, currentSongId, dir = 1) {
  const { songsHash, shuffleSongsIndex, normalSongsIndex } = playlist
  const songsIndex = playMode === PLAY_MODE.SHUFFLE ? shuffleSongsIndex : normalSongsIndex
  const len = songsIndex.length
  const currentSongIndex = songsIndex.findIndex(index => index === currentSongId)
  const nextSongIndex = currentSongIndex === -1 ? 0 : (len + currentSongIndex + dir) % len
  const song = songsHash[songsIndex[nextSongIndex]]
  return updateSongWithUrl(song).then(song => {
    // some song have no valid url, need to be skipped
    if (!song.url) {
      return getSong(playlist, playMode, song.id, dir)
    }
    return song
  })
}

function updateSongWithUrl (song) {
  return api.getSongUrls([song.id]).then(res => {
    if (res.code === 200) {
      const { url } = res.data[0]
      song.url = url
      return song
    }
  })
}

function shuffleArray (array) {
  const _array = array.slice()
  for (let i = _array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [_array[i], _array[j]] = [_array[j], _array[i]]
  }
  return _array
}

function loadRecommandSongsPlaylist (userId) {
  const playlist = { id: generateId(), creator: { nickname: '网易云音乐' }, name: '每日推荐歌曲' }
  return loadRecommandSongs(userId).then(songs => {
    playlist.tracks = songs
    playlist.coverImgUrl = songs[0].al.picUrl
    return tidyPlaylist(playlist)
  })
}

function generateId () {
  return Number(Math.random().toString().substr(3, 8))
}

function loadAllPlaylists () {
  const { userId } = store
  return Promise.all([loadRecommandSongsPlaylist(userId), loadUserPlaylist(userId)]).then(result => {
    const [recommendSongsPlaylist, userPlaylists] = result
    return [recommendSongsPlaylist, ...userPlaylists]
  })
}

function loadRecommandSongs (userId) {
  return api.getRecommendSongs(userId).then(res => {
    if (res.code === 200) {
      return res.recommend.map(song => {
        const { id, album: al, artists: ar } = song
        return { id, al, ar }
      })
    } else {
      throw new Error('获取推荐音乐失败')
    }
  })
}

function loadUserPlaylist (userId) {
  return api.getUserPlaylist(userId).then(res => {
    if (res.code === 200) {
      return Promise.all(res.playlist.map(playlist => {
        return api.getPlaylistDetail(playlist.id)
      })).then(result => {
        return result.filter(res => res.code === 200).map(res => tidyPlaylist(res.playlist))
      })
    } else {
      throw new Error('获取我的歌单失败')
    }
  })
}

function loadSongWhenPlaylistChanged (_songId) {
  const { playlist, songId } = getPlaylistBySongId(_songId)
  return getSong(playlist, store.playMode, songId)
}

function getPlaylistBySongId (songId) {
  const { song, playlistGroup, selectedPlaylistId } = store
  songId = songId || (song ? song.id : TOP_NEW_ID)
  let playlist = playlistGroup.find(playlist => playlist.id === selectedPlaylistId)
  if (!playlist) {
    playlist = playlistGroup[0]
    songId = TOP_NEW_ID
  }
  return { playlist, songId }
}

function updateLikeSongsPlaylist () {
  const { playlistGroup } = store
  const likeSongPlaylistIndex = 2
  const playlistId = playlistGroup[likeSongPlaylistIndex].id
  return api.getPlaylistDetail(playlistId).then(res => {
    if (res.code === 200) {
      const playlist = tidyPlaylist(res.playlist)
      playlistGroup[likeSongPlaylistIndex] = playlist
      return playlistGroup
    } else {
      throw new Error('刷新喜欢的音乐歌单失败')
    }
  })
}

function persist (change) {
  const toPersistDataKeys = Object.keys(change)
    .filter(key => OMIT_PERSIST_KEYS.indexOf(key) === -1)
  if (toPersistDataKeys.length === 0) return
  const toPersistData = toPersistDataKeys.reduce((acc, key) => {
    acc[key] = change[key]
    return acc
  }, {})
  chrome.storage.sync.set(toPersistData)
}

subscribeKey(store, 'song', song => {
  if (audio) {
    audio.src = song.url
  } else {
    audio = new Audio(song.url)
  }
  if (store.playing) {
    audio.autoplay = true
  }
  audio.onprogress = () => {
    if (audio.buffered.length) {
      const loadPercentage = (audio.buffered.end(audio.buffered.length - 1) / audio.duration) * 100
      updateAudioState({
        loadPercentage
      })
    }
  }
  audio.oncanplay = () => {
    audio.onprogress()
    updateAudioState({
      duration: audio.duration
    })
  }
  audio.onabort = () => {
    updateAudioState({
      currentTime: 0
    })
  }
  audio.onended = () => {
    updateAudioState({
      currentTime: 0
    })
    store.playNext()
  }
  audio.onerror = (e) => {
    console.log(e)
  }
  audio.ontimeupdate = () => {
    updateAudioState({
      currentTime: audio.currentTime
    })
  }
})

function updateAudioState (state) {
  const { audioState } = store
  const newAudioState = { ...audioState, ...state }
  store.audioState = newAudioState
  chrome.runtime.sendMessage({
    action: 'audioState',
    audioState: newAudioState
  })
}

export default store
