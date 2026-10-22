package org.gohigh.android.api

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/*
 * Tolerant serializers for fields whose JSON type the contract leaves open (ids as number or string,
 * "unread" as flag or count, …). They never throw on a type mismatch; they fall back to a neutral value.
 */

/** Accepts a string, number or boolean and keeps it as string. */
object LenientStringSerializer : KSerializer<String> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("gohigh.LenientString", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): String {
        val json = decoder as? JsonDecoder ?: return decoder.decodeString()
        return when (val el = json.decodeJsonElement()) {
            is JsonNull -> ""
            is JsonPrimitive -> el.content
            else -> el.toString()
        }
    }

    override fun serialize(encoder: Encoder, value: String) = encoder.encodeString(value)
}

/** Accepts true/false, numbers (> 0 is true) and "true"/"1"/"yes". */
object LenientBooleanSerializer : KSerializer<Boolean> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("gohigh.LenientBoolean", PrimitiveKind.BOOLEAN)

    override fun deserialize(decoder: Decoder): Boolean {
        val json = decoder as? JsonDecoder ?: return decoder.decodeBoolean()
        val el = json.decodeJsonElement() as? JsonPrimitive ?: return false
        if (el is JsonNull) return false
        el.booleanOrNull?.let { return it }
        el.doubleOrNull?.let { return it > 0 }
        return el.content.lowercase() in setOf("true", "1", "yes", "ja")
    }

    override fun serialize(encoder: Encoder, value: Boolean) = encoder.encodeBoolean(value)
}

/** Accepts numbers, numeric strings and booleans (true = 1). */
object LenientIntSerializer : KSerializer<Int> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("gohigh.LenientInt", PrimitiveKind.INT)

    override fun deserialize(decoder: Decoder): Int {
        val json = decoder as? JsonDecoder ?: return decoder.decodeInt()
        val el = json.decodeJsonElement() as? JsonPrimitive ?: return 0
        if (el is JsonNull) return 0
        el.booleanOrNull?.let { return if (it) 1 else 0 }
        return el.doubleOrNull?.toInt() ?: el.content.toIntOrNull() ?: 0
    }

    override fun serialize(encoder: Encoder, value: Int) = encoder.encodeInt(value)
}
