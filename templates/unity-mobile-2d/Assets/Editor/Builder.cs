using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

// Called by `unity build --target Android --execute-method Builder.Android -o Builds/game.aab`. The CLI forwards the output as -buildOutput.
// Declared in the manifest as stack.unity.executeMethods, so the orchestrator allows exactly this method.
public static class Builder
{
    public static void Android()
    {
        var output = ArgumentValue("-buildOutput") ?? "Builds/game.aab";
        PlayerSettings.productName = "{{NAME}}";
        PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android, "com.paperclip.{{PACKAGE}}");
        PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);
        PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
        PlayerSettings.defaultInterfaceOrientation = UIOrientation.{{ORIENTATION}};
        EditorUserBuildSettings.buildAppBundle = output.EndsWith(".aab", StringComparison.OrdinalIgnoreCase);

        var scenes = EditorBuildSettings.scenes.Where(scene => scene.enabled).Select(scene => scene.path).ToArray();
        if (scenes.Length == 0)
        {
            // A project without a game scene yet still builds: an empty scene keeps the build gate meaningful from the first task.
            Directory.CreateDirectory("Assets/Scenes");
            var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects);
            EditorSceneManager.SaveScene(scene, "Assets/Scenes/Main.unity");
            scenes = new[] { "Assets/Scenes/Main.unity" };
        }

        Directory.CreateDirectory(Path.GetDirectoryName(output) ?? ".");
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions { scenes = scenes, locationPathName = output, target = BuildTarget.Android, options = BuildOptions.None });
        if (report.summary.result != BuildResult.Succeeded)
        {
            Debug.LogError("Android build failed: " + report.summary.result);
            EditorApplication.Exit(1);
        }
    }

    private static string ArgumentValue(string name)
    {
        var args = Environment.GetCommandLineArgs();
        for (var i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
        return null;
    }
}
