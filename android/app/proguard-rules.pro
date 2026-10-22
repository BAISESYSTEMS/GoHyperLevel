# HyperLevel release rules. kotlinx.serialization, WorkManager and Glance ship their own consumer rules.

# Glance instantiates ActionCallbacks by class name.
-keep class * implements androidx.glance.appwidget.action.ActionCallback { <init>(); }
# Widget receivers/widgets are referenced from the manifest and by reflection in Glance sessions.
-keep class org.gohigh.android.widget.** extends androidx.glance.appwidget.GlanceAppWidget { <init>(); }

# Keep serializer lookups for our DTOs (belt and braces on top of the library rules).
-keepclassmembers @kotlinx.serialization.Serializable class org.gohigh.android.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepattributes *Annotation*, InnerClasses, Signature

# OkHttp optional platform classes
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
