using System.IO;
using UnityEngine;

namespace Game.Tests
{
    /// <summary>
    /// Screenshot evidence for reviews. `unity test` runs in batch mode where WaitForEndOfFrame never fires, so a camera is rendered to a
    /// RenderTexture and read back. PNGs go to Logs/screenshots, which the orchestrator copies to the reviewer.
    /// </summary>
    public static class ScreenshotCapture
    {
        public static string Save(Camera camera, string name, int width = 540, int height = 960)
        {
            var directory = Path.Combine(Path.GetDirectoryName(Application.dataPath) ?? ".", "Logs", "screenshots");
            Directory.CreateDirectory(directory);
            var target = new RenderTexture(width, height, 24);
            var previousTarget = camera.targetTexture;
            var previousActive = RenderTexture.active;
            try
            {
                camera.targetTexture = target;
                camera.Render();
                RenderTexture.active = target;
                var texture = new Texture2D(width, height, TextureFormat.RGB24, false);
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply();
                var path = Path.Combine(directory, name + ".png");
                File.WriteAllBytes(path, texture.EncodeToPNG());
                Object.Destroy(texture);
                return path;
            }
            finally
            {
                camera.targetTexture = previousTarget;
                RenderTexture.active = previousActive;
                target.Release();
                Object.Destroy(target);
            }
        }
    }
}
