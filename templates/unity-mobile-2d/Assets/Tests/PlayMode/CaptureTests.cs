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
            camera.orthographic = true;
            camera.orthographicSize = 1f;
            // A procedural gradient stands in for a real screen; screen tests replace it with the screen they built (a blank frame fails ScreenshotCapture.Save).
            var texture = new Texture2D(32, 64);
            for (var y = 0; y < 64; y++) for (var x = 0; x < 32; x++) texture.SetPixel(x, y, Color.Lerp(new Color(0.9f, 0.4f, 0.1f), new Color(0.2f, 0.3f, 0.9f), (x + y) / 96f));
            texture.Apply();
            var quad = GameObject.CreatePrimitive(PrimitiveType.Quad);
            quad.transform.position = new Vector3(0f, 0f, 5f);
            quad.transform.localScale = new Vector3(1.2f, 2f, 1f);
            quad.GetComponent<Renderer>().sharedMaterial = new Material(Shader.Find("Unlit/Texture")) { mainTexture = texture };
            yield return null;
            var path = ScreenshotCapture.Save(camera, "initial");
            Assert.IsTrue(File.Exists(path));
            Assert.AreNotEqual(UnityEngine.Rendering.GraphicsDeviceType.Null, SystemInfo.graphicsDeviceType, "the capture needs a real graphics device");
            Object.Destroy(cameraObject);
            Object.Destroy(quad);
        }
    }
}
