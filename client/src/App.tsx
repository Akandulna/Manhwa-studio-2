import { Routes, Route } from 'react-router-dom'
import { Toaster } from '@/components/ui/toaster'
import Layout from '@/components/Layout'
import Library from '@/pages/Library'
import AddSeries from '@/pages/AddSeries'
import ManualUpload from '@/pages/ManualUpload'
import SeriesDetail from '@/pages/SeriesDetail'
import DownloadQueue from '@/pages/DownloadQueue'
import StitchLibrary from '@/pages/stitch/StitchLibrary'
import StitchWorkspace from '@/pages/stitch/StitchWorkspace'
import ChapterPreview from '@/pages/ChapterPreview'
import Settings from '@/pages/Settings'
import { SocketProvider } from '@/lib/socket'

// Module 2: Narration Studio
import NarrationLibrary from '@/pages/narration/NarrationLibrary'
import SeriesScriptView from '@/pages/narration/SeriesScriptView'
import ScriptEditor from '@/pages/narration/ScriptEditor'
import VoiceoverEditor from '@/pages/narration/VoiceoverEditor'

// Module 3: Image Clipper 3.0
import Clipper3Library from '@/pages/clipper3/Clipper3Library'
import Clipper3SeriesView from '@/pages/clipper3/Clipper3SeriesView'
import Clipper3ImageList from '@/pages/clipper3/Clipper3ImageList'
import Clipper3Preview from '@/pages/clipper3/Clipper3Preview'

// Music Library
import MusicLibrary from '@/pages/music/MusicLibrary'

// Sleeper Cells: the phone app's status
import SleeperCells from '@/pages/sleeper/SleeperCells'

// Storage: local disk usage + cleanup
import StorageManager from '@/pages/storage/StorageManager'

// Module 4: Editor 2.0
import EditorLibrary2 from '@/pages/editor2/EditorLibrary2'
import EditorChapterList2 from '@/pages/editor2/EditorChapterList2'
import Editor2Preview from '@/pages/editor2/Editor2Preview'

function App() {
  return (
    <SocketProvider>
      <Layout>
        <Routes>
          {/* Module 1: Library & Downloader */}
          <Route path="/" element={<Library />} />
          <Route path="/add" element={<AddSeries />} />
          <Route path="/add/manual" element={<ManualUpload />} />
          <Route path="/series/:id" element={<SeriesDetail />} />
          <Route path="/queue" element={<DownloadQueue />} />
          <Route path="/stitch" element={<StitchLibrary />} />
          <Route path="/stitch/chapter/:id" element={<StitchWorkspace />} />
          <Route path="/chapter/:id/preview" element={<ChapterPreview />} />
          
          {/* Module 2: Narration Studio */}
          <Route path="/narration" element={<NarrationLibrary />} />
          <Route path="/narration/series/:id" element={<SeriesScriptView />} />
          <Route path="/narration/chapter/:id" element={<ScriptEditor />} />
          <Route path="/narration/voiceover/:id" element={<VoiceoverEditor />} />
          
          {/* Module 3: Image Clipper 3.0 */}
          <Route path="/clipper3" element={<Clipper3Library />} />
          <Route path="/clipper3/series/:id" element={<Clipper3SeriesView />} />
          <Route path="/clipper3/chapter/:id" element={<Clipper3ImageList />} />
          <Route path="/clipper3/chapter/:id/preview" element={<Clipper3Preview />} />

          {/* Music Library */}
          <Route path="/music" element={<MusicLibrary />} />

          {/* Module 4: Editor 2.0 */}
          <Route path="/editor2" element={<EditorLibrary2 />} />
          <Route path="/editor2/:seriesId" element={<EditorChapterList2 />} />
          <Route path="/editor2/chapter/:chapterId/preview" element={<Editor2Preview />} />

          {/* Sleeper Cells */}
          <Route path="/sleeper-cells" element={<SleeperCells />} />

          {/* Shared */}
          <Route path="/storage" element={<StorageManager />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Layout>
      <Toaster />
    </SocketProvider>
  )
}

export default App
