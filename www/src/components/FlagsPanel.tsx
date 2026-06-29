import { useState } from 'react'
import { useAction } from 'use-kbd'
import { Dialog, DialogTitle, DialogContent, IconButton, Box, Typography, FormControl, RadioGroup, FormControlLabel, Radio, Button, Chip } from '@mui/material'
import { FLAGS, FlagName, FlagSource, useFlagsController, isFlagVisible } from '../contexts/FlagsContext'

const SOURCE_COLORS: Record<FlagSource, 'primary' | 'warning' | 'default'> = {
  url: 'warning',
  localStorage: 'primary',
  default: 'default',
}

export function FlagsPanel() {
  const [open, setOpen] = useState(false)
  const { flags, sources, setFlag, resetFlag } = useFlagsController()

  useAction('flags:open', {
    label: 'Open feature flags panel',
    group: 'Debug',
    defaultBindings: ['shift+f', 'cmd+shift+f'],
    handler: () => setOpen(true),
  })

  const visible = (Object.keys(FLAGS) as FlagName[]).filter(isFlagVisible)

  return (
    <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Feature flags
        <IconButton onClick={() => setOpen(false)} size="small" aria-label="Close">×</IconButton>
      </DialogTitle>
      <DialogContent>
        {visible.length === 0 && <Typography color="text.secondary">No flags registered.</Typography>}
        {visible.map((name) => {
          const def = FLAGS[name]
          const value = flags[name]
          const source = sources[name]
          return (
            <Box key={name} sx={{ mb: 2, pb: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Typography component="code" sx={{ fontWeight: 600 }}>{name}</Typography>
                <Chip label={source} size="small" color={SOURCE_COLORS[source]} variant="outlined" />
                {source !== 'default' && (
                  <Button size="small" onClick={() => resetFlag(name)} sx={{ ml: 'auto' }}>Reset</Button>
                )}
              </Box>
              {def.description && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  {def.description}
                </Typography>
              )}
              <FormControl>
                <RadioGroup
                  row
                  value={value}
                  onChange={(e) => setFlag(name, e.target.value as never)}
                >
                  {def.options.map((opt) => (
                    <FormControlLabel
                      key={opt}
                      value={opt}
                      control={<Radio size="small" />}
                      label={<code>{opt}</code>}
                    />
                  ))}
                </RadioGroup>
              </FormControl>
            </Box>
          )
        })}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Priority: URL <code>?flag.{'{'}name{'}'}=…</code> &gt; localStorage &gt; default.
          Selecting a value writes to localStorage; Reset clears it.
        </Typography>
      </DialogContent>
    </Dialog>
  )
}
