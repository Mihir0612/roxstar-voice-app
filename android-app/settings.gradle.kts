pluginManagement {
    repositories {
        // Content filters keep Gradle from asking Google's repo for artifacts it
        // will never have. In Kotlin DSL the backslash must be escaped: "\\."
        // means a literal dot in the regex, and a bare "\." is a compile error.
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "Roxstar"
include(":app")
