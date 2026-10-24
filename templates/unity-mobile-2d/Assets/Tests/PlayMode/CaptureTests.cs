using System.Collections;
using System.IO;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace Game.Tests
{
    /// <summary>
    /// The orchestrator runs this fixture for review evidence. Extend it: every screen the game has gets a test here that builds or loads the screen,
    /// waits a frame, and calls ScreenshotCapture.Save with a descriptive name (for example "play-board", "menu", "game-over").
    /// </summary>
    public class CaptureTests
    {
        [UnityTest]
        public IEnumerator CapturesTheInitialView()
        {
            var cameraObject = new GameObject("capture camera");
            var camera = cameraObject.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.08f, 0.1f, 0.16f);
            yield return null;
            var path = ScreenshotCapture.Save(camera, "initial");
            Assert.IsTrue(File.Exists(path));
            Assert.AreNotEqual(UnityEngine.Rendering.GraphicsDeviceType.Null, SystemInfo.graphicsDeviceType, "the capture needs a real graphics device");
            Object.Destroy(cameraObject);
        }
    }
}
